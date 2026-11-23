import type { Element } from '@weq/codec';
import { toGapMessage, type GapFetchedMessage } from '@weq/service/gap-history';
import { createMsgPushRegistry, decodeMessageBodies, decodePushEnvelope } from '@weqbot/protocol';
import { clientReadTargets } from '@weqbot/protocol/qq-sync';

const LIVE_WINDOW_MS = 30_000;
const LIMIT = 512;
const pushRegistry = createMsgPushRegistry();

export interface LivePushUpdates {
  reads: Array<{ chatType: 1 | 2; uid: string; sequence: string }>;
  groups: Array<{ groupCode: string; directory: boolean }>;
  reactions: Array<{ groupCode: string; sequence: number }>;
  recalled: boolean;
  interactions: Array<{ kind: 'group' | 'c2c'; conv: string }>;
}

export function decodeLivePush(body: Uint8Array, selfUid: string, selfUin: string, now: number) {
  const { messages } = decodePushEnvelope(body);
  const rows: GapFetchedMessage[] = [];
  const updates: LivePushUpdates = {
    reads: [],
    groups: [],
    reactions: [],
    recalled: false,
    interactions: [],
  };
  if (!selfUid) return { rows, updates };
  let haveReads = false;
  let routedReads = true;
  const groups = new Map<string, boolean>();
  const interactions = new Map<string, LivePushUpdates['interactions'][number]>();
  const markInteraction = (kind: 'group' | 'c2c', conv: string) => {
    if (!(kind === 'group' ? /^[1-9]\d{0,15}$/ : /^u_[A-Za-z0-9_-]+$/).test(conv)) return;
    interactions.set(`${kind}:${conv}`, { kind, conv });
  };
  for (const raw of messages) {
    const { contentHead: head, responseHead: peers } = raw;
    const group = peers?.grp?.groupUin;
    const age = now - (head?.timestamp ?? 0) * 1000;
    if (
      (head?.msgType === 528 && head.subType === 8) ||
      (head?.msgType === 732 && head.subType === 1)
    ) {
      haveReads = true;
      routedReads &&= Boolean(
        (peers?.toUid === selfUid || String(peers?.toUin) === selfUin) &&
          (!peers?.toUid || peers.toUid === selfUid) &&
          (!peers?.toUin || String(peers.toUin) === selfUin) &&
          (head.msgType !== 528 || !peers?.fromUid || peers.fromUid === selfUid),
      );
      continue;
    }
    if (
      (head?.msgType === 528 &&
        (head.subType === 138 || head.subType === 139 || head.subType === 290)) ||
      (head?.msgType === 732 && (head.subType === 16 || head.subType === 17 || head.subType === 20))
    ) {
      const event = pushRegistry.decode(raw);
      if (
        event?.kind === 'group-reaction' &&
        Number.isSafeInteger(event.groupUin) &&
        event.groupUin > 0 &&
        Number.isSafeInteger(event.sequence) &&
        event.sequence > 0 &&
        event.sequence <= 0xffffffff
      ) {
        // QQ 的数据库状态包含总数和自己是否已回应。推送仅提供精确的重读目标。
        updates.reactions.push({ groupCode: String(event.groupUin), sequence: event.sequence });
      }
      if (event?.kind === 'group-recall') {
        updates.recalled = true;
        markInteraction('group', String(event.groupUin));
      } else if (event?.kind === 'friend-recall') {
        updates.recalled = true;
        if (event.toUid === selfUid) markInteraction('c2c', event.fromUid);
        else if (event.fromUid === selfUid) markInteraction('c2c', event.toUid);
      } else if (event?.kind === 'poke' && event.toUid === selfUid && event.fromUid !== selfUid) {
        if (event.groupUin) markInteraction('group', String(event.groupUin));
        else markInteraction('c2c', event.fromUid);
      }
      continue;
    }
    if (
      head?.msgType === 33 ||
      head?.msgType === 34 ||
      head?.msgType === 44 ||
      head?.msgType === 85
    ) {
      const event = pushRegistry.decode(raw);
      if (
        (event?.kind === 'group-admin' || event?.kind === 'group-member') &&
        Number.isSafeInteger(event.groupUin) &&
        event.groupUin > 0
      ) {
        const code = String(event.groupUin);
        const directory =
          event.kind === 'group-member' &&
          (event.action === 'self-join' ||
            event.action === 'disband' ||
            event.memberUid === selfUid);
        groups.set(code, Boolean(groups.get(code) || directory));
      }
      continue;
    }
    if (
      !head?.msgId ||
      !peers?.fromUid ||
      peers.fromUid === selfUid ||
      age < -5000 ||
      age > LIVE_WINDOW_MS ||
      !(group
        ? head.msgType === 82 && head.sequence
        : head.msgType === 166 &&
          !head.c2cCmd &&
          head.ntMsgSeq &&
          peers.toUid === selfUid &&
          String(peers.toUin) === selfUin) ||
      raw.body?.msgContent?.length ||
      raw.body?.richText?.notOnlineFile ||
      !raw.body?.richText?.elems?.length ||
      raw.body.richText.elems.some((element) =>
        Object.keys(element).some(
          (key) => key !== 'text' && key !== 'bubble' && key !== 'generalFlags',
        ),
      )
    )
      continue;
    const event = decodeMessageBodies([raw])[0];
    if (!event?.message.elements.length || event.message.elements.some((e) => e.kind !== 'text'))
      continue;
    const row = toGapMessage(
      group ? 'group' : 'c2c',
      group ? String(group) : peers.fromUid,
      event.message,
    );
    rows.push({ ...row, sourceFormat: 'protocol', msgRandom: String(head.msgId) });
  }
  updates.interactions = [...interactions.values()];
  updates.groups = [...groups].map(([groupCode, directory]) => ({ groupCode, directory }));
  if (haveReads && routedReads) {
    try {
      const reads = new Map<string, LivePushUpdates['reads'][number]>();
      for (const target of clientReadTargets(body)) {
        if (
          !Number.isSafeInteger(target.sequence) ||
          target.sequence <= 0 ||
          target.sequence > 0xffffffff
        )
          continue;
        const chatType = target.kind === 'group' ? 2 : 1;
        const uid = target.kind === 'group' ? String(target.groupUin) : target.targetUid;
        if (!(chatType === 2 ? /^[1-9]\d{0,15}$/ : /^u_[A-Za-z0-9_-]+$/).test(uid)) continue;
        const key = `${chatType}:${uid}`;
        const prior = reads.get(key);
        if (!prior || target.sequence > Number(prior.sequence))
          reads.set(key, { chatType, uid, sequence: String(target.sequence) });
      }
      updates.reads = [...reads.values()];
    } catch {
      // 新消息和群资料仍可处理，已读留给数据库。
    }
  }
  return { rows, updates };
}

type IdentityRow = Pick<GapFetchedMessage, 'kind' | 'conv' | 'msgSeq' | 'msgRandom' | 'senderUid'>;

function key(row: IdentityRow) {
  if (!row.msgRandom || row.msgRandom === '0' || !row.senderUid) return undefined;
  return JSON.stringify([row.kind, row.conv, row.msgSeq, row.msgRandom, row.senderUid]);
}

export class LiveMessages {
  private readonly entries = new Map<string, { at: number; row?: GapFetchedMessage }>();

  private expire(now: number) {
    for (const [id, entry] of this.entries) {
      if (now - entry.at <= LIVE_WINDOW_MS && this.entries.size <= LIMIT) break;
      this.entries.delete(id);
    }
  }

  accept(rows: GapFetchedMessage[], now: number) {
    this.expire(now);
    const accepted = rows.filter((row) => {
      const id = key(row);
      if (!id || this.entries.has(id)) return false;
      this.entries.set(id, { at: now, row });
      return true;
    });
    this.expire(now);
    return accepted;
  }

  confirm(row: IdentityRow, now: number, storedElements: readonly Element[]): boolean {
    const id = key(row);
    if (!id) return false;
    const entry = this.entries.get(id);
    const shown = entry?.row?.elements;
    const displayed = Boolean(
      entry &&
        now - entry.at <= LIVE_WINDOW_MS &&
        shown &&
        shown.length === storedElements.length &&
        storedElements.every((element, index) => {
          const previous = shown[index];
          return (
            previous?.type === 'text' &&
            element.kind === 'text' &&
            previous.data.textContent === element.textContent
          );
        }),
    );
    this.entries.delete(id);
    this.entries.set(id, { at: now });
    this.expire(now);
    return displayed;
  }

  forConversation(kind: GapFetchedMessage['kind'], conv: string, now: number) {
    this.expire(now);
    return [...this.entries.values()].flatMap(({ row }) =>
      row?.kind === kind && row.conv === conv ? [row] : [],
    );
  }
}
