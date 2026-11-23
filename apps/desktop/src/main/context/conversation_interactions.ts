import { EventEmitter } from 'node:events';
import type { AccountSession } from '@weq/account';
import type { Element } from '@weq/codec';
import { type InteractionMessagePosition, withDatabasePriority } from '@weq/db';
import { JsonStore } from '@weq/service/json-store';
import { NEW_CONV_FRESH_SEC } from '@weq/service/live-message';
import { onSettingsChanged } from '@weq/service/settings-changes';
import type { UnreadInfoService } from '@weq/service';
import {
  conversationInteractionId,
  type ConversationInteraction,
} from '../../shared/conversation_interaction';

type Kind = ConversationInteraction['kind'];
type InteractionConversation = Pick<ConversationInteraction, 'kind' | 'conv'>;
type ScanTargets = Map<Kind, Set<string>>;
type InteractionBaseline = {
  latest: Map<string, bigint>;
  idsByConversation: Map<string, Set<string>>;
};
type Watermarks = Pick<UnreadInfoService, 'getUnreadInfos' | 'onCountsChanged'>;
const kinds: Kind[] = ['c2c', 'group'];
const pokeVerb = /拍了拍|戳了戳/;
const chatType = (kind: Kind) => (kind === 'group' ? 2 : 1);
const convKey = (kind: Kind, conv: string) => `${chatType(kind)}_${conv}`;

function pokePeople(element: Extract<Element, { kind: 'grayTipPoke' | 'grayTipXml' }>) {
  const [before, after] = (element.grayTipXmlContent ?? '').split(pokeVerb, 2);
  const xmlPerson = (text?: string) =>
    /<qq\b[^>]*\b(?:uid|uin)=["']([^"']+)["']/i.exec(text ?? '')?.[1];
  const actor = xmlPerson(before);
  const target = xmlPerson(after);
  // 实机戳一戳可把收件人写进 actionInitiator，成对的灰条参与者优先。
  if (actor && target) return [actor, target];
  if (element.tipJson) {
    try {
      const { items } = JSON.parse(element.tipJson) as {
        items?: Array<{ type?: string; txt?: string; uid?: string; uin?: string }>;
      };
      const index =
        items?.findIndex((item) => item?.type === 'nor' && pokeVerb.test(item.txt ?? '')) ?? -1;
      if (items && index >= 0) {
        const person = (item: (typeof items)[number]) =>
          item?.type === 'qq' && (item.uid || item.uin);
        const from = items.slice(0, index).map(person).find(Boolean);
        const to = items
          .slice(index + 1)
          .map(person)
          .find(Boolean);
        if (from && to) return [from, to];
      }
    } catch {
      // 只提示能够确认参与者的互动。
    }
  }
  return [element.actionInitiator?.uid, element.actionTarget?.uid];
}

export function incomingConversationInteraction(
  elements: Element[],
  self: ReadonlySet<string>,
): ConversationInteraction['action'] | undefined {
  for (const element of elements) {
    if (
      element.kind === 'grayTipRevoke' &&
      element.recallRevokeUid &&
      !self.has(element.recallRevokeUid)
    )
      return 'recall';
    if (element.kind !== 'grayTipXml' && element.kind !== 'grayTipPoke') continue;
    const detail =
      'detailedId' in element
        ? element.detailedId
        : element.kind === 'grayTipXml'
          ? element.detailId
          : undefined;
    if (detail !== 1061) continue;
    const [actor, target] = pokePeople(element);
    if (actor && target && !self.has(actor) && self.has(target)) return 'poke';
  }
}

interface InteractionState {
  // 撤回横幅独立于原消息的已读水位。
  pending: ConversationInteraction[];
  seen: string[];
  seenRecalls: string[];
  candidates: BadgeCandidate[];
}

type BadgeCandidate = ConversationInteraction &
  (
    | { action: 'recall'; seq: string }
    | { action: 'poke' | 'seqless'; sentAt: number; attachedSeq?: string; seen?: true }
  );

function validEvent(event: ConversationInteraction): boolean {
  return (
    !!event &&
    kinds.includes(event.kind) &&
    typeof event.conv === 'string' &&
    typeof event.msgId === 'string' &&
    /^-?\d{1,20}$/.test(event.msgId)
  );
}

function seenRecallIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id) => typeof id === 'string' && id.endsWith(',"recall"]')).slice(-2048)
    : [];
}

function after(message: InteractionMessagePosition, anchor: InteractionMessagePosition): boolean {
  return message.sentAt === anchor.sentAt
    ? BigInt(message.msgId) > BigInt(anchor.msgId)
    : message.sentAt > anchor.sentAt;
}

export class ConversationInteractionBadges {
  private readonly store: JsonStore<InteractionState>;
  private readonly events = new EventEmitter();
  private readonly reads = new AbortController();
  private readonly self: ReadonlySet<string>;
  private readonly stopSettings: () => void;
  private readonly baselines = new Map<Kind, InteractionBaseline>();
  private stopWatermarks?: () => void;
  private eligible = new Set<string>();
  private scanInFlight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private scheduledAt?: number;
  private reconcileAt?: number;
  private targetAt?: number;
  private proxyTargets: ScanTargets = new Map();
  private proxyRevision = 0;
  private watching = false;
  private generation = 0;
  private projection = 0;

  constructor(
    private readonly session: AccountSession,
    path: string,
    private readonly enabled: () => boolean,
    private readonly watermarks: () => Watermarks | undefined,
  ) {
    this.self = new Set([session.selfUid, String(session.context.uin)].filter(Boolean));
    this.store = new JsonStore<InteractionState>(
      path,
      () => ({ pending: [], seen: [], seenRecalls: [], candidates: [] }),
      {
        normalize: (value) => {
          const { pending, seen, seenRecalls, candidates } = (value ??
            {}) as Partial<InteractionState>;
          return {
            pending: Array.isArray(pending)
              ? pending.filter((event) => validEvent(event) && event.action === 'recall')
              : [],
            seen: seenRecallIds(seen),
            seenRecalls: seenRecallIds(seenRecalls ?? seen),
            candidates: Array.isArray(candidates)
              ? candidates.filter(
                  (event) =>
                    validEvent(event) &&
                    (event.action === 'recall'
                      ? typeof event.seq === 'string' && /^[1-9]\d{0,19}$/.test(event.seq)
                      : (event.action === 'poke' || event.action === 'seqless') &&
                        Number.isSafeInteger(event.sentAt) &&
                        (event.attachedSeq === undefined ||
                          /^[1-9]\d{0,19}$/.test(event.attachedSeq))),
                )
              : [],
          };
        },
      },
    );
    this.stopSettings = onSettingsChanged(() => {
      if (this.watching !== this.enabled()) this.requestScan();
    });
  }

  subscribe(onChange: (events: ConversationInteraction[]) => void): () => void {
    this.requestScan();
    this.events.on('change', onChange);
    onChange(this.pendingEvents());
    return () => this.events.off('change', onChange);
  }

  get seenIds(): readonly string[] {
    return this.store.data.seen;
  }

  get badgeEvents(): ConversationInteraction[] {
    return this.store.data.candidates.flatMap(({ kind, conv, msgId, action, storedWithoutSeq }) => {
      const event = { kind, conv, msgId, action, storedWithoutSeq };
      return this.eligible.has(conversationInteractionId(event)) ? [event] : [];
    });
  }

  unsequencedIds(kind: Kind, conv: string): bigint[] {
    return this.badgeEvents
      .filter((event) => event.kind === kind && event.conv === conv && event.storedWithoutSeq)
      .slice(-64)
      .map((event) => BigInt(event.msgId));
  }

  private pendingEvents(): ConversationInteraction[] {
    const pending = new Map(
      this.badgeEvents.map((event) => [conversationInteractionId(event), event]),
    );
    for (const event of this.store.data.pending)
      pending.set(conversationInteractionId(event), { ...event, bannerPending: true });
    return [...pending.values()];
  }

  private publish(): void {
    this.events.emit('change', this.pendingEvents());
  }

  requestScan(defer = false): void {
    if (this.reads.signal.aborted) return;
    const watching = this.enabled();
    if (this.watching !== watching) {
      this.watching = watching;
      this.generation++;
      this.baselines.clear();
      clearTimeout(this.timer);
      this.timer = undefined;
      this.scheduledAt = undefined;
      this.reconcileAt = undefined;
      this.targetAt = undefined;
      this.proxyTargets.clear();
      if (!watching) {
        this.stopWatermarks?.();
        this.stopWatermarks = undefined;
        this.eligible.clear();
        this.publish();
      }
    }
    if (!watching) return;
    this.stopWatermarks ??= this.watermarks()?.onCountsChanged((targets) => {
      const changed = new Set(targets.map(({ chatType, uid }) => `${chatType}_${uid}`));
      if (this.store.data.candidates.some(({ kind, conv }) => changed.has(convKey(kind, conv))))
        void this.project(this.generation).catch(() => {});
    });
    const delay = this.baselines.size || this.scanInFlight ? (defer ? 3000 : 400) : 0;
    this.reconcileAt = Math.min(this.reconcileAt ?? Infinity, Date.now() + delay);
    this.scheduleScan();
  }

  observeProxyConversations(targets: readonly InteractionConversation[]): void {
    if (this.reads.signal.aborted || !this.enabled() || !targets.length) return;
    if (!this.watching) this.requestScan();
    for (const { kind, conv } of targets) {
      let conversations = this.proxyTargets.get(kind);
      if (!conversations) {
        conversations = new Set();
        this.proxyTargets.set(kind, conversations);
      }
      if (conversations.size < 128) conversations.add(conv);
    }
    this.targetAt ??= Date.now() + 250;
    // 代理知道目标，其他同时发生的库变化仍有固定期限校准。
    this.reconcileAt ??= Date.now() + 3000;
    this.scheduleScan();
  }

  clearProxyConversations(): void {
    this.proxyRevision++;
    this.proxyTargets.clear();
    this.targetAt = undefined;
    if (this.reconcileAt !== undefined || this.scanInFlight) this.requestScan();
    else this.scheduleScan();
  }

  private scheduleScan(): void {
    if (!this.watching || this.reads.signal.aborted || this.scanInFlight) return;
    const at = Math.min(this.reconcileAt ?? Infinity, this.targetAt ?? Infinity);
    if (this.scheduledAt === at) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduledAt = Number.isFinite(at) ? at : undefined;
    if (!Number.isFinite(at)) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.scheduledAt = undefined;
        let targets: ScanTargets | undefined;
        if (this.reconcileAt !== undefined && this.reconcileAt <= Date.now()) {
          this.reconcileAt = undefined;
        } else {
          this.targetAt = undefined;
          targets = this.proxyTargets;
          this.proxyTargets = new Map();
        }
        this.scanInFlight = this.scan(targets)
          .catch(() => {})
          .finally(() => {
            this.scanInFlight = undefined;
            this.scheduleScan();
          });
      },
      Math.max(0, at - Date.now()),
    ).unref();
  }

  private async scan(targets?: ScanTargets): Promise<void> {
    if (!this.enabled()) return;
    const generation = this.generation;
    const proxyRevision = this.proxyRevision;
    const observedAt = Math.floor(Date.now() / 1000);
    const scans = await Promise.allSettled(
      (targets ? [...targets.keys()] : kinds).map((kind) =>
        withDatabasePriority(
          'background',
          async () => ({
            kind,
            // 私聊文件的撤回时间较长。更早的群管理撤回可从防撤回记录接入。
            window: await this.session.recentContacts.recentInteractionWindow(
              kind,
              observedAt - (kind === 'c2c' ? 7200 : 600),
              targets ? [...(targets.get(kind) ?? [])] : undefined,
            ),
          }),
          this.reads.signal,
        ),
      ),
    );
    const newEvents: BadgeCandidate[] = [];
    const previousRecalls = new Set(this.store.data.pending.map(conversationInteractionId));
    for (const result of scans) {
      if (
        this.reads.signal.aborted ||
        !this.enabled() ||
        this.generation !== generation ||
        (targets && this.proxyRevision !== proxyRevision)
      )
        return;
      if (result.status !== 'fulfilled') continue;
      const { kind, window } = result.value;
      const old = this.baselines.get(kind);
      const idsByConversation = new Map<string, Set<string>>();
      for (const { seq, conv, msgId, sentAt, senderUid, elements } of window.tips) {
        const action =
          incomingConversationInteraction(elements, this.self) ??
          (seq === 0n &&
          senderUid &&
          !this.self.has(senderUid) &&
          !elements.some(
            ({ kind }) =>
              kind === 'grayTipPoke' || kind === 'grayTipXml' || kind === 'grayTipRevoke',
          )
            ? 'seqless'
            : undefined);
        if (!action || !conv || !msgId || msgId === '0') continue;
        const event = { kind, conv, msgId, action };
        const id = conversationInteractionId(event);
        let ids = idsByConversation.get(conv);
        if (!ids) {
          ids = new Set();
          idsByConversation.set(conv, ids);
        }
        ids.add(id);
        const previousSeq = old?.latest.get(conv);
        const existingMessage =
          previousSeq !== undefined && seq <= previousSeq && seq > previousSeq - 64n;
        if (old ? old.idsByConversation.get(conv)?.has(id) : !previousRecalls.has(id)) continue;
        if (action === 'recall') {
          if (
            seq > 0n &&
            !this.self.has(senderUid) &&
            (existingMessage ||
              previousRecalls.has(id) ||
              observedAt - sentAt <= NEW_CONV_FRESH_SEC)
          )
            newEvents.push({ ...event, action, seq: String(seq) });
        } else if (sentAt > 0 && observedAt - sentAt <= NEW_CONV_FRESH_SEC) {
          newEvents.push({
            ...event,
            action,
            sentAt,
            attachedSeq: seq > 0n ? String(seq) : undefined,
            storedWithoutSeq: seq === 0n ? true : undefined,
          });
        }
      }
      if (targets && old) {
        for (const [conv, latest] of window.latest) {
          old.latest.set(conv, latest);
          old.idsByConversation.set(conv, idsByConversation.get(conv) ?? new Set());
        }
      } else {
        this.baselines.set(kind, { latest: window.latest, idsByConversation });
      }
    }
    // 先保存检测结果；未读数据暂不可用时，下次仍能重新判断这些消息。
    const state = this.store.data;
    const known = new Set([
      ...state.seenRecalls,
      ...state.candidates.map(conversationInteractionId),
    ]);
    const additions = newEvents.filter((event) => {
      const id = conversationInteractionId(event);
      if (known.has(id)) return false;
      known.add(id);
      return true;
    });
    if (additions.length)
      this.store.replace({ ...state, candidates: [...state.candidates, ...additions] });
    await this.project(generation);
  }

  private async project(generation: number): Promise<void> {
    const { candidates } = this.store.data;
    const source = this.watermarks();
    if (!candidates.length || !source) return;
    const projection = ++this.projection;
    const keys = new Map(
      candidates.map(({ kind, conv }) => [
        convKey(kind, conv),
        { chatType: chatType(kind), uid: conv },
      ]),
    );
    const snapshots = await source.getUnreadInfos([...keys.values()], false, true);
    const watermarks = new Map(
      snapshots.flatMap((row) =>
        row.readError || row.readSeq === undefined
          ? []
          : [[row.peer, BigInt(row.readSeq)] as const],
      ),
    );
    const anchors = await Promise.all(
      kinds.map((kind) => {
        const unique = new Map<string, bigint>();
        for (const event of candidates) {
          if (event.kind !== kind || event.action === 'recall') continue;
          const read = watermarks.get(convKey(kind, event.conv));
          if (read !== undefined) unique.set(event.conv, read);
        }
        return unique.size
          ? withDatabasePriority(
              'background',
              () =>
                this.session.recentContacts.recentInteractionAnchors(
                  kind,
                  [...unique].map(([conv, readSeq]) => ({ conv, readSeq })),
                ),
              this.reads.signal,
            )
          : undefined;
      }),
    );
    if (
      this.reads.signal.aborted ||
      this.generation !== generation ||
      this.projection !== projection ||
      !this.enabled()
    )
      return;
    const checked = new Set(candidates.map(conversationInteractionId));
    const state = this.store.data;
    const eligible = new Set<string>();
    const retained = state.candidates.filter((event) => {
      const id = conversationInteractionId(event);
      const floor = watermarks.get(convKey(event.kind, event.conv));
      if (!checked.has(id) || floor === undefined) {
        if (this.eligible.has(id)) eligible.add(id);
        return true;
      }
      if (event.action === 'recall') {
        if (BigInt(event.seq) <= floor) return false;
      } else {
        const anchor = anchors[event.kind === 'c2c' ? 0 : 1]?.get(event.conv);
        // 戳一戳借用正文序号来定位；同序号时才用时间和 ID 确定前后。
        const attached = event.attachedSeq === undefined ? undefined : BigInt(event.attachedSeq);
        const latest = anchor?.latest;
        if (event.seen && latest) {
          const followed =
            attached !== undefined && latest.seq !== attached
              ? latest.seq > attached
              : after(latest, event);
          if (followed) return false;
        }
        if (attached !== undefined && attached < floor) return false;
        if (attached === undefined || attached === floor) {
          if (anchor?.read && !after(event, anchor.read)) return false;
          if (floor > 0n && !anchor?.read) return true;
        }
        if (event.seen) return true;
      }
      eligible.add(id);
      return true;
    });
    const changed =
      eligible.size !== this.eligible.size || [...eligible].some((id) => !this.eligible.has(id));
    this.eligible = eligible;
    if (retained.length !== state.candidates.length)
      this.store.replace({ ...state, candidates: retained });
    if (changed) this.publish();
  }

  observeRecall(
    {
      kind,
      conv,
      msgId,
      revokeUid,
      origSeq,
      senderUid,
    }: {
      kind: Kind | 'dataline';
      conv: string;
      msgId: string;
      revokeUid: string;
      origSeq: string;
      senderUid: string;
    },
    forBanner = false,
    knownMessage = false,
  ): void {
    if (this.reads.signal.aborted || kind === 'dataline' || !revokeUid || this.self.has(revokeUid))
      return;
    const event = { kind, conv, msgId, action: 'recall' } as const;
    if (!validEvent(event)) return;
    const id = conversationInteractionId(event);
    const state = this.store.data;
    const { pending, seen, seenRecalls, candidates } = state;
    const addBanner =
      forBanner &&
      !seen.includes(id) &&
      !pending.some((event) => conversationInteractionId(event) === id);
    const addBadge =
      this.enabled() &&
      !this.self.has(senderUid) &&
      /^[1-9]\d{0,19}$/.test(origSeq) &&
      !seenRecalls.includes(id) &&
      !candidates.some((event) => conversationInteractionId(event) === id);
    if (!addBanner && !addBadge) return;
    this.store.replace({
      ...state,
      pending: addBanner ? [...pending, event] : pending,
      candidates: addBadge ? [...candidates, { ...event, seq: origSeq }] : candidates,
    });
    if (addBanner) this.publish();
    if (addBadge && knownMessage && this.watching)
      void this.project(this.generation).catch(() => this.requestScan());
    else if (addBadge) this.requestScan();
  }

  acknowledge(ids: string[], bannerOnly = false): void {
    const state = this.store.data;
    const { pending, seen, seenRecalls, candidates } = state;
    const read = new Set(ids);
    const recalls = new Set<string>();
    const next = pending.filter((event) => !read.has(conversationInteractionId(event)));
    for (const event of pending) {
      const id = conversationInteractionId(event);
      if (read.has(id)) recalls.add(id);
    }
    let changed = next.length !== pending.length;
    const confirmedRecalls = new Set(recalls);
    const remaining = bannerOnly
      ? candidates
      : candidates.flatMap((event): BadgeCandidate[] => {
          const id = conversationInteractionId(event);
          if (!read.has(id) || (event.action !== 'recall' && event.seen)) return [event];
          changed = true;
          this.eligible.delete(id);
          if (event.action !== 'recall') return [{ ...event, seen: true }];
          recalls.add(id);
          confirmedRecalls.add(id);
          return [];
        });
    if (!changed) return;
    this.store.replace({
      pending: next,
      seen: [...new Set([...seen, ...recalls])].slice(-2048),
      seenRecalls: bannerOnly
        ? seenRecalls
        : [...new Set([...seenRecalls, ...confirmedRecalls])].slice(-2048),
      candidates: remaining,
    });
    this.publish();
    if (!bannerOnly && remaining.some((event) => event.action !== 'recall' && event.seen))
      void this.project(this.generation).catch(() => {});
  }

  dispose(): void {
    this.reads.abort();
    this.stopSettings();
    this.stopWatermarks?.();
    clearTimeout(this.timer);
    this.events.removeAllListeners();
  }
}
