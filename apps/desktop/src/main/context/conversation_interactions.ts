import { EventEmitter } from 'node:events';
import type { AccountSession } from '@weq/account';
import type { Element } from '@weq/codec';
import { withDatabasePriority } from '@weq/db';
import { JsonStore } from '@weq/service/json-store';
import { NEW_CONV_FRESH_SEC } from '@weq/service/live-message';
import { onSettingsChanged } from '@weq/service/settings-changes';
import {
  conversationInteractionId,
  type ConversationInteraction,
} from '../../shared/conversation_interaction';

type Kind = ConversationInteraction['kind'];
const kinds: Kind[] = ['c2c', 'group'];
const pokeVerb = /拍了拍|戳了戳/;

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
  pending: ConversationInteraction[];
  seen: string[];
}

export class ConversationInteractionBadges {
  private readonly store: JsonStore<InteractionState>;
  private readonly events = new EventEmitter();
  private readonly reads = new AbortController();
  private readonly self: ReadonlySet<string>;
  private readonly stopSettings: () => void;
  private readonly baselines = new Map<Kind, { latest: Map<string, bigint>; ids: Set<string> }>();
  private scanInFlight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private watching = false;
  private generation = 0;

  constructor(
    private readonly session: AccountSession,
    path: string,
    private readonly enabled: () => boolean,
  ) {
    this.self = new Set([session.selfUid, String(session.context.uin)].filter(Boolean));
    this.store = new JsonStore(path, () => ({ pending: [], seen: [] }), {
      normalize: (value) => {
        const { pending, seen } = (value ?? {}) as Partial<InteractionState>;
        return {
          pending: Array.isArray(pending)
            ? pending.filter(
                (event) =>
                  event &&
                  kinds.includes(event.kind) &&
                  typeof event.conv === 'string' &&
                  typeof event.msgId === 'string' &&
                  /^-?\d{1,20}$/.test(event.msgId) &&
                  (event.action === 'poke' || event.action === 'recall'),
              )
            : [],
          seen: Array.isArray(seen) ? seen.filter((id) => typeof id === 'string').slice(-2048) : [],
        };
      },
    });
    this.stopSettings = onSettingsChanged(() => {
      if (this.watching !== this.enabled()) this.requestScan();
    });
  }

  subscribe(onChange: (events: ConversationInteraction[]) => void): () => void {
    this.events.on('change', onChange);
    onChange(this.store.data.pending);
    this.requestScan();
    return () => this.events.off('change', onChange);
  }

  get seenIds(): readonly string[] {
    return this.store.data.seen;
  }

  requestScan(): void {
    if (this.reads.signal.aborted) return;
    const watching = this.enabled();
    if (this.watching !== watching) {
      this.watching = watching;
      this.generation++;
      this.baselines.clear();
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!watching || this.timer) return;
    // 同一批文件变化合并，独立于普通消息的水位和通知。
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.scanInFlight) return this.requestScan();
        this.scanInFlight = this.scan()
          .catch(() => {})
          .finally(() => {
            this.scanInFlight = undefined;
          });
      },
      this.baselines.size || this.scanInFlight ? 400 : 0,
    );
    this.timer.unref?.();
  }

  private async scan(): Promise<void> {
    if (!this.enabled()) return;
    const generation = this.generation;
    const observedAt = Math.floor(Date.now() / 1000);
    const scans = await Promise.allSettled(
      kinds.map((kind) =>
        withDatabasePriority(
          'background',
          async () => ({
            kind,
            // 私聊文件的撤回时间较长。更早的群管理撤回可从防撤回记录接入。
            window: await this.session.recentContacts.recentInteractionWindow(
              kind,
              observedAt - (kind === 'c2c' ? 7200 : 600),
            ),
          }),
          this.reads.signal,
        ),
      ),
    );
    const newEvents: ConversationInteraction[] = [];
    for (const result of scans) {
      if (this.reads.signal.aborted || !this.enabled() || this.generation !== generation) return;
      if (result.status !== 'fulfilled') continue;
      const { kind, window } = result.value;
      const old = this.baselines.get(kind);
      const ids = new Set<string>();
      for (const { seq, conv, msgId, sentAt, elements } of window.tips) {
        const action = incomingConversationInteraction(elements, this.self);
        if (!action || !conv || !msgId || msgId === '0') continue;
        const event = { kind, conv, msgId, action };
        const id = conversationInteractionId(event);
        ids.add(id);
        const previousSeq = old?.latest.get(conv);
        const existingMessage =
          previousSeq !== undefined && seq <= previousSeq && seq > previousSeq - 64n;
        if (
          old &&
          !old.ids.has(id) &&
          ((action === 'recall' && existingMessage) || observedAt - sentAt <= NEW_CONV_FRESH_SEC)
        )
          newEvents.push(event);
      }
      this.baselines.set(kind, { latest: window.latest, ids });
    }
    this.add(newEvents);
  }

  observeRecall(
    event: { kind: Kind | 'dataline'; conv: string; msgId: string; revokeUid: string },
    forBanner = false,
  ) {
    const { kind, conv, msgId, revokeUid } = event;
    if (kind !== 'dataline' && revokeUid && !this.self.has(revokeUid))
      this.add([{ kind, conv, msgId, action: 'recall' }], forBanner);
  }

  private add(events: ConversationInteraction[], forBanner = false): void {
    if (!events.length || this.reads.signal.aborted || (!forBanner && !this.enabled())) return;
    const { pending, seen } = this.store.data;
    const existing = new Set([...seen, ...pending.map(conversationInteractionId)]);
    const additions = events.filter((event) => {
      const id = conversationInteractionId(event);
      if (existing.has(id)) return false;
      existing.add(id);
      return true;
    });
    if (additions.length) this.save({ pending: [...pending, ...additions], seen });
  }

  acknowledge(ids: string[]): void {
    const { pending, seen } = this.store.data;
    const read = new Set(ids);
    const next = pending.filter((event) => !read.has(conversationInteractionId(event)));
    if (next.length === pending.length) return;
    const removed = pending.map(conversationInteractionId).filter((id) => read.has(id));
    this.save({ pending: next, seen: [...seen, ...removed].slice(-2048) });
  }

  private save(state: InteractionState): void {
    this.store.replace(state);
    this.events.emit('change', state.pending);
  }

  dispose(): void {
    this.reads.abort();
    this.stopSettings();
    clearTimeout(this.timer);
    this.events.removeAllListeners();
  }
}
