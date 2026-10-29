import type { GapFetchedMessage, RenderC2cMsg, RenderGroupMsg } from '@weq/service';
import { mergeRoamingTimeline } from '@weq/service/roaming-timeline';
import { compareMessageOrder } from '@weq/codec';
import type { ActionServices, ActionSession } from './actions';
import { ActionError, bool, id, integer, type Params } from './contracts';
import type { BridgeMessage, OneBotServer } from './server';

export function localHistoryRow(
  kind: 'c2c' | 'group',
  conv: string,
  row: RenderC2cMsg | RenderGroupMsg,
): GapFetchedMessage {
  return {
    kind,
    conv,
    msgId: String(row.msgId),
    msgSeq: String(row.msgSeq),
    msgRandom: String(row.msgRandom ?? 0n),
    clientSeq: String('clientSeq' in row ? (row.clientSeq ?? 0n) : 0n),
    senderUid: row.senderUid,
    senderUin: String(row.senderUin),
    sendTime: String(row.sendTime),
    elements: row.elements,
  };
}

export function createHistory(
  services: ActionServices,
  session: ActionSession,
  requireActive: () => void,
  server: () => Pick<OneBotServer, 'resolve' | 'register' | 'messageData'>,
  project: (row: GapFetchedMessage) => Promise<BridgeMessage | null>,
) {
  return async (kind: 'c2c' | 'group', p: Params) => {
    requireActive();
    const targetId = id(kind === 'group' ? p.group_id : p.user_id);
    const conv = kind === 'group' ? targetId : session.uidMap.uidByUin(BigInt(targetId));
    if (!conv) throw new ActionError('找不到私聊会话的 UID', 1404);
    const count = integer(p.count, 20, 1, 200);
    const descending = !bool(p.reverse_order ?? p.reverseOrder);
    let min = integer(p.start_seq, 1, 1);
    let max = integer(p.end_seq, 0xffffffff, 1);
    let cursor: { msgSeq: bigint; sendTime: bigint; msgId: bigint } | undefined;
    let anchorIdentity: BridgeMessage | null = null;
    const pivot = p.message_seq ?? p.message_id;
    if (pivot !== undefined && String(pivot) !== '0') {
      const raw = String(pivot);
      let anchor: BridgeMessage | null = null;
      if (/^-\d+$/.test(raw))
        anchor = await server().resolve(integer(raw, undefined, -2147483647, -1));
      else if (/^\d+$/.test(raw) && BigInt(raw) > 0xffffffffn) {
        const row =
          kind === 'group'
            ? await services.msgs.getGroupMessageById(conv, BigInt(raw))
            : await services.msgs.getC2cMessageById(conv, BigInt(raw));
        requireActive();
        if (!row || ('targetGroupCode' in row ? row.targetGroupCode : row.targetUid) !== conv)
          throw new ActionError('历史锚点不存在于该会话', 1404);
        anchor = await project(localHistoryRow(kind, conv, row));
      } else if (descending) max = Math.min(max, integer(pivot, undefined, 1));
      else min = Math.max(min, integer(pivot, undefined, 1));
      if (anchor) {
        anchorIdentity = anchor;
        if (
          anchor.peerType !== kind ||
          anchor.targetId !== targetId ||
          !anchor.location?.msgId ||
          !anchor.location.msgSeq
        )
          throw new ActionError('历史锚点属于其他会话或缺少分页定位');
        cursor = {
          msgSeq: BigInt(anchor.location.msgSeq),
          sendTime: BigInt(anchor.time),
          msgId: BigInt(anchor.location.msgId),
        };
        if (descending) max = Math.min(max, anchor.location.msgSeq);
        else min = Math.max(min, anchor.location.msgSeq);
      }
    }
    if (min > max) throw new ActionError('历史区间无效');
    let networkRequested = false;
    if (bool(p.fetch_remote)) {
      if (max === 0xffffffff && !cursor && p.end_seq === undefined)
        throw new ActionError('在线补全需要明确锚点或 end_seq');
      const start = descending ? Math.max(min, max - count + 1) : min;
      const end = descending ? max : Math.min(max, min + count - 1);
      for (let next: number | null = start; next !== null; ) {
        const result = await services.gapHistory.fetch(kind, conv, next, end, {
          strictIdentity: true,
          beforeRequest: requireActive,
        });
        requireActive();
        networkRequested ||= Boolean(result.networkRequested);
        if (!result.ok) throw new ActionError(result.message, 1500);
        next = result.nextStartSeq;
      }
    }
    const local = await services.msgs.getHistoryPage(kind, conv, {
      cursor,
      min: BigInt(min),
      max: BigInt(max),
      descending,
      limit: count + 2,
    });
    requireActive();
    const cached = await services.gapHistory.cachedTimeline(
      kind,
      conv,
      min,
      max,
      count + 2,
      descending,
      cursor
        ? {
            msgSeq: Number(cursor.msgSeq),
            sendTime: Number(cursor.sendTime),
            msgId: String(cursor.msgId),
          }
        : undefined,
    );
    requireActive();
    const merged = mergeRoamingTimeline(
      kind,
      local.map((row) => localHistoryRow(kind, conv, row)),
      cached,
      { min: BigInt(min), max: BigInt(max), descending },
    ).filter(
      (row) =>
        !anchorIdentity?.location?.random ||
        row.msgSeq !== String(anchorIdentity.location.msgSeq) ||
        row.msgRandom !== String(anchorIdentity.location.random) ||
        row.senderUin !== String(anchorIdentity.senderUin),
    );
    const page = merged.slice(0, count);
    const projected: BridgeMessage[] = [];
    for (const row of page) {
      const message = await project(row);
      requireActive();
      if (!message) throw new ActionError('历史记录无法转换，未跳过该分页位置', 1500);
      projected.push(message);
    }
    const next = projected.at(-1);
    projected.sort((a, b) =>
      compareMessageOrder(
        {
          msgSeq: String(a.location?.msgSeq ?? 0),
          sendTime: String(a.time),
          msgId: a.location?.msgId ?? '0',
        },
        {
          msgSeq: String(b.location?.msgSeq ?? 0),
          sendTime: String(b.time),
          msgId: b.location?.msgId ?? '0',
        },
      ),
    );
    return {
      messages: projected.map((row) => server().messageData(row)),
      next_message_seq: next ? server().register(next) : null,
      has_more: merged.length > count,
      network_requested: networkRequested,
    };
  };
}
