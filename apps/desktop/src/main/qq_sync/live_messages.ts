import type { Element } from '@weq/codec';
import { toGapMessage, type GapFetchedMessage } from '@weq/service/gap-history';
import {
  createMsgPushRegistry,
  decodeMessageBodies,
  decodePushEnvelope,
  type PushEvent,
} from '@weqbot/protocol';
import { clientReadTargets } from '@weqbot/protocol/qq-sync';
import type { QqLiveBusinessEvent, QqLivePeer } from '../../shared/qq_live_business';

const LIVE_WINDOW_MS = 30_000;
const LIMIT = 512;
const pushRegistry = createMsgPushRegistry();
const uidPattern = /^u_[A-Za-z0-9_-]+$/;
const INPUT_STATUS_MS = 6000;
const CHAT_PUSH_TYPES = new Set([82, 141, 166, 9, 208, 529]);
const PRIVATE_CONTROL_COMMANDS = new Set([1, 73, 75, 129, 131, 133, 135, 192]);
const LIVE_ELEMENT_FIELDS = new Set([
  'text',
  'bubble',
  'generalFlags',
  'replyElement',
  'extraInfo',
  'face',
  'marketFace',
  'commonElem',
  'transElem',
  'richMsg',
  'lightApp',
  'wallet',
]);

function businessEvent(
  event: PushEvent | null,
  selfUid: string,
  now: number,
): QqLiveBusinessEvent | undefined {
  if (!event) return;
  switch (event.kind) {
    case 'friend-request':
      if (
        event.fromUid !== selfUid &&
        uidPattern.test(event.fromUid) &&
        (!event.targetUid || event.targetUid === selfUid)
      )
        return { kind: event.kind, uid: event.fromUid };
      return;
    case 'friend-add':
      if (
        event.uid !== selfUid &&
        uidPattern.test(event.uid) &&
        (!event.toUid || event.toUid === selfUid)
      )
        return { kind: event.kind, uid: event.uid };
      return;
    case 'input-status': {
      if (event.toUid !== selfUid || event.fromUid === selfUid || !uidPattern.test(event.fromUid))
        return;
      if (event.eventType !== 1 && event.eventType !== 3) return;
      const at = event.time * 1000;
      if (at && (at > now + 5000 || now - at >= INPUT_STATUS_MS)) return;
      return {
        kind: event.kind,
        uid: event.fromUid,
        speaking: event.eventType === 3,
        expiresAt: Math.min(at || now, now) + INPUT_STATUS_MS,
      };
    }
    case 'group-request':
    case 'group-mute':
    case 'group-essence': {
      if (!Number.isSafeInteger(event.groupUin) || event.groupUin <= 0) return;
      const groupCode = String(event.groupUin);
      if (event.kind === 'group-request') return { kind: event.kind, groupCode };
      const at = event.time * 1000 || now;
      if (at > now + 5000 || now - at > LIVE_WINDOW_MS) return;
      if (event.kind === 'group-mute') {
        if (event.targetUid && !uidPattern.test(event.targetUid)) return;
        return { kind: event.kind, groupCode, uid: event.targetUid, duration: event.duration, at };
      }
      if (!Number.isInteger(event.sequence) || event.sequence <= 0 || event.sequence > 0xffffffff)
        return;
      return {
        kind: event.kind,
        groupCode,
        sequence: String(event.sequence),
        active: event.set,
        at,
      };
    }
  }
}

function isLiveWireElement(element: Record<string, unknown>): boolean {
  const keys = Object.keys(element);
  if (!keys.length || keys.some((key) => !LIVE_ELEMENT_FIELDS.has(key))) return false;
  const common = element.commonElem as
    | {
        serviceType?: number;
        businessType?: number;
        pbElem?: Uint8Array;
      }
    | undefined;
  if (common?.serviceType === 48)
    return [10, 12, 14, 20, 21, 22].includes(common.businessType ?? 0) && !!common.pbElem?.length;
  if (common)
    return (
      common.serviceType === 2 ||
      ([3, 23, 33, 37, 45, 46].includes(common.serviceType ?? 0) && !!common.pbElem?.length)
    );
  const transfer = element.transElem as { elemType?: number; elemValue?: Uint8Array } | undefined;
  if (transfer) return transfer.elemType === 24 && !!transfer.elemValue?.length;
  const rich = element.richMsg as { serviceId?: number; template1?: Uint8Array } | undefined;
  return !rich || (rich.serviceId === 35 && !!rich.template1?.length);
}

function hasRenderableLiveElements(elements: readonly Record<string, unknown>[]): boolean {
  let replies = 0;
  return (
    elements.length > 0 &&
    elements.every((element) => {
      switch (element.kind) {
        case 'text':
        case 'at':
          return true;
        case 'reply':
          return (
            ++replies === 1 &&
            Number(element.origMsgSeq) > 0 &&
            (Number(element.origSenderUin) > 0 || Boolean(element.origSenderUid))
          );
        case 'pic':
          return (
            Boolean(element.fileToken || element.originalUrl) &&
            !String(element.fileToken ?? '').startsWith('/') &&
            ((Number(element.imgWidth) > 0 && Number(element.imgHeight) > 0) ||
              element.isFlash === true)
          );
        case 'ptt':
          return Boolean(element.fileName && element.fileToken) && Number(element.pttDuration) > 0;
        case 'face':
          return Number.isInteger(element.faceId);
        case 'mface':
          return Boolean(element.marketEmoticonId);
        case 'video':
        case 'bubbleVideo':
        case 'file':
          return Boolean(element.fileName && element.fileToken);
        case 'ark':
          return Boolean(element.arkData);
        case 'multiMsg':
          return Boolean(element.resId || element.xmlContent);
        case 'wallet':
          return Boolean(element.walletDetail);
        case 'markdown':
          return Boolean(element.markdownContent || element.flashTransferInfo);
        case 'inlineKeyboard':
          return Boolean(element.keyboardRows);
        case 'emojiBounce':
          return true;
        default:
          return false;
      }
    }) &&
    replies < elements.length
  );
}

export interface LivePushUpdates {
  reads: Array<{ chatType: 1 | 2; uid: string; sequence: string }>;
  groups: Array<{ groupCode: string; directory: boolean }>;
  reactions: Array<{ groupCode: string; sequence: number }>;
  recalled: boolean;
  interactions: Array<{ kind: 'group' | 'c2c'; conv: string }>;
  business: QqLiveBusinessEvent[];
}

export type LiveMessage = GapFetchedMessage & { livePeer: QqLivePeer };

export function decodeLivePush(body: Uint8Array, selfUid: string, selfUin: string, now: number) {
  const { messages } = decodePushEnvelope(body);
  const rows: LiveMessage[] = [];
  const updates: LivePushUpdates = {
    reads: [],
    groups: [],
    reactions: [],
    recalled: false,
    interactions: [],
    business: [],
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
    const temporary = head?.msgType === 141;
    const group = temporary ? undefined : peers?.grp?.groupUin;
    const age = now - (head?.timestamp ?? 0) * 1000;
    if (
      head?.msgType === 84 ||
      head?.msgType === 87 ||
      head?.msgType === 525 ||
      (head?.msgType === 528 && [35, 179, 226, 277].includes(head.subType ?? 0)) ||
      (head?.msgType === 732 && (head.subType === 12 || head.subType === 21))
    ) {
      const event = businessEvent(pushRegistry.decode(raw), selfUid, now);
      if (event) updates.business.push(event);
      continue;
    }
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
      !uidPattern.test(peers.fromUid) ||
      !CHAT_PUSH_TYPES.has(head.msgType ?? 0) ||
      (head.msgType === 82 && !group) ||
      age < -5000 ||
      age > LIVE_WINDOW_MS ||
      ((head.msgType === 141 || head.msgType === 166) &&
        PRIVATE_CONTROL_COMMANDS.has(head.c2cCmd ?? 0)) ||
      raw.body?.richText?.elems?.some((element) => !isLiveWireElement(element))
    )
      continue;
    const sent = peers.fromUid === selfUid;
    const conv = group ? String(group) : sent ? peers.toUid : peers.fromUid;
    if (!conv) continue;
    if (
      group
        ? !head.sequence
        : !head.ntMsgSeq ||
          !uidPattern.test(conv) ||
          conv === selfUid ||
          (sent
            ? Boolean(peers.fromUin && String(peers.fromUin) !== selfUin)
            : peers.toUid !== selfUid || String(peers.toUin) !== selfUin)
    )
      continue;
    try {
      const event = decodeMessageBodies([raw])[0];
      if (!event || !hasRenderableLiveElements(event.message.elements)) continue;
      if (
        raw.body?.msgContent?.length &&
        !event.message.elements.some((element) => element.kind === 'file')
      )
        continue;
      const row = toGapMessage(group ? 'group' : 'c2c', conv, event.message);
      const elements = row.elements.map((element) =>
        element.type === 'ptt'
          ? { ...element, data: { ...element.data, livePending: true } }
          : element,
      );
      rows.push({
        ...row,
        livePeer: group
          ? { peerName: peers.grp?.groupName }
          : {
              peerUin: String(sent ? (peers.toUin ?? '') : (peers.fromUin ?? '')),
              peerName: sent ? undefined : event.message.sender.name,
              ...(temporary
                ? {
                    temporary: true,
                    tempSourceGroupCode: String(
                      (peers.forward as { tempGroupUin?: number } | undefined)?.tempGroupUin ?? '',
                    ),
                  }
                : {}),
            },
        ...(temporary ? { msgSeq: String(head.ntMsgSeq) } : {}),
        elements,
        sourceFormat: 'protocol',
        // 群聊实时推送已校验普通正文的会话序号；历史漫游不沿用这个确认。
        ntSeqVerified: group ? true : row.ntSeqVerified,
        msgRandom: String(head.msgId),
      });
    } catch {
      // 不完整的富媒体仍由 QQ 落库处理，不影响同包里其他消息。
    }
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
  private readonly entries = new Map<
    string,
    { at: number; row?: GapFetchedMessage; receivedLive?: true }
  >();

  private expire(now: number) {
    for (const [id, entry] of this.entries) {
      if (now - entry.at <= LIVE_WINDOW_MS && this.entries.size <= LIMIT) break;
      this.entries.delete(id);
    }
  }

  accept<T extends GapFetchedMessage>(rows: T[], now: number) {
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

  confirm(row: IdentityRow, now: number, storedElements: readonly Element[]) {
    const id = key(row);
    if (!id) return undefined;
    const entry = this.entries.get(id);
    const receivedLive =
      !!entry && now - entry.at <= LIVE_WINDOW_MS && Boolean(entry.row || entry.receivedLive);
    const shown = entry?.row?.elements;
    const sameText = Boolean(
      receivedLive &&
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
    this.entries.set(id, { at: now, ...(receivedLive ? { receivedLive: true } : {}) });
    this.expire(now);
    return { receivedLive, sameText };
  }

  forConversation(kind: GapFetchedMessage['kind'], conv: string, now: number) {
    this.expire(now);
    return [...this.entries.values()].flatMap(({ row }) =>
      row?.kind === kind && row.conv === conv ? [row] : [],
    );
  }
}
