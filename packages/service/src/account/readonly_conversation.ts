import type { AccountSession } from '@weq/account';
import type { C2cMsg } from '@weq/db';
import { resolveC2cPartition } from './c2c_partition';
import { toRenderElements } from './msg_view';

export interface ReadonlyMessageCursor {
  msgSeq: string;
  sendTime: string;
  msgId: string;
}

export interface ReadonlyPageRequest {
  cursor?: ReadonlyMessageCursor;
  anchorId?: string;
  limit?: number;
  direction?: 'older' | 'newer';
}

/** 使用数据库的三字段游标；序号为零或重号的记录也参与分页。 */
export async function readonlyConversationPage(
  session: AccountSession,
  target: { kind: 'official'; peerUid: string } | { kind: 'service'; appId: string },
  request: ReadonlyPageRequest,
) {
  const database = target.kind === 'service' ? session.serviceAssistantMsgs : session.c2cMsgs;
  const partition =
    target.kind === 'service'
      ? { appId: BigInt(target.appId) }
      : await resolveC2cPartition(session.uidMap, target.peerUid);
  const limit = Math.max(1, Math.min(200, request.limit ?? 50));
  const options = {
    min: -(1n << 63n),
    max: (1n << 63n) - 1n,
    descending: request.direction !== 'newer',
    limit: limit + 1,
    includeSeqless: true,
  };
  let items: C2cMsg[];
  if (request.anchorId) {
    const [anchor] = await database.calendarMessage(partition, BigInt(request.anchorId));
    if (!anchor)
      return { items: [], hasMore: false, nextCursor: null, newerCursor: null, found: false };
    const cursor = { msgSeq: anchor.msgSeq, sendTime: anchor.sendTime, msgId: anchor.msgId };
    const [before, after] = await Promise.all([
      database.listHistory(partition, {
        ...options,
        cursor,
        descending: true,
        limit: Math.ceil(limit / 2),
      }),
      database.listHistory(partition, {
        ...options,
        cursor,
        descending: false,
        limit: Math.floor(limit / 2),
      }),
    ]);
    items = [...after.reverse(), anchor, ...before];
  } else {
    const cursor = request.cursor && {
      msgSeq: BigInt(request.cursor.msgSeq),
      sendTime: BigInt(request.cursor.sendTime),
      msgId: BigInt(request.cursor.msgId),
    };
    items = await database.listHistory(partition, { ...options, cursor });
  }
  const hasMore = items.length > limit || Boolean(request.anchorId);
  const page = items.slice(0, limit);
  if (request.direction === 'newer') page.reverse();
  const last = page.at(-1);
  const first = page[0];
  return {
    items: page.map((message) => ({ ...message, elements: toRenderElements(message.elements) })),
    hasMore,
    nextCursor: last
      ? { msgSeq: String(last.msgSeq), sendTime: String(last.sendTime), msgId: String(last.msgId) }
      : null,
    found: true,
    newerCursor: first
      ? {
          msgSeq: String(first.msgSeq),
          sendTime: String(first.sendTime),
          msgId: String(first.msgId),
        }
      : null,
  };
}
