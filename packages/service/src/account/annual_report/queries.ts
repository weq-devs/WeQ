import type { AccountSession } from '@weq/account';
import type { ReportQueries } from './types';

/**
 * Create the typed query capability passed to page compute / availability hooks.
 *
 * The surface is deliberately small and typed: pages get read-only, account-bound
 * queries and never touch `AccountSession`, a database handle or raw SQL.
 */
export function createReportQueries(session: AccountSession): ReportQueries {
  // 自己的 uid 用 session 打开时已经驻留内存的 uidMap（nt_uid_mapping_table）
  // 反查，不在这里对 c2c 消息表做任何推断扫描。群聊方向计数按 uid 精确匹配
  // 40020，和 chat 里既有的 selfUid / 群活跃统计口径一致。
  const selfUin = BigInt(Number(session.context.uin) || 0);
  const selfUid = selfUin > 0n ? (session.uidMap.uidByUin(selfUin) ?? '') : '';

  type DirectionCounts = {
    c2cSent: number;
    c2cReceived: number;
    groupSent: number;
    groupReceived: number;
  };
  const countCache = new Map<string, Promise<DirectionCounts>>();
  let oldestCache: Promise<number | null> | null = null;
  let sentYearsCache: Promise<number[]> | null = null;

  function oldestMessageTime(): Promise<number | null> {
    if (oldestCache) return oldestCache;
    oldestCache = Promise.all([
      session.c2cMsgs.oldestSendTime(),
      session.groupMsgs.oldestSendTime(),
    ])
      .then(([c2c, group]) => {
        const candidates = [c2c, group].filter((v): v is bigint => v != null && v > 0n);
        return candidates.length === 0
          ? null
          : Number(candidates.reduce((a, b) => (a < b ? a : b)));
      })
      .catch((error: unknown) => {
        oldestCache = null;
        throw error;
      });
    return oldestCache;
  }

  /**
   * 「发出过至少一条消息」的年份并集，升序去重。私聊按行内自证方向判定，群聊
   * 用与 countByDirection 同一个 self marker（uid 优先、uin 兜底）。
   */
  function sentYears(): Promise<number[]> {
    if (sentYearsCache) return sentYearsCache;
    sentYearsCache = Promise.all([
      session.c2cMsgs.sentYears(),
      session.groupMsgs.sentYears(
        selfUid ? { senderUid: selfUid } : selfUin > 0n ? { selfUin } : {},
      ),
    ])
      .then(([c2c, group]) => [...new Set([...c2c, ...group])].sort((a, b) => a - b))
      .catch((error: unknown) => {
        sentYearsCache = null;
        throw error;
      });
    return sentYearsCache;
  }

  return {
    overview: {
      /**
       * Sent / received split for one time window, one pass per table. Only
       * real private chats (c2c_msg_table) and group chats (group_msg_table)
       * are counted — dataline / service tables are never queried here.
       */
      async countByDirection(startTime: number, endTime: number) {
        const key = `${startTime}:${endTime}`;
        let running = countCache.get(key);
        if (!running) {
          running = Promise.all([
            // c2c 方向由行内数据自证（senderUid != targetUid），无需 uidMap。
            session.c2cMsgs.countByDirection({ startTime, endTime }),
            session.groupMsgs.countByDirection({
              startTime,
              endTime,
              ...(selfUid ? { senderUid: selfUid } : selfUin > 0n ? { selfUin } : {}),
            }),
          ]).then(([c2c, group]) => ({
            c2cSent: c2c.sent,
            c2cReceived: c2c.received,
            groupSent: group.sent,
            groupReceived: group.received,
          }));
          countCache.set(key, running);
          // 失败时清掉缓存，页面重试可以重新扫；成功结果保留供 availability/compute 复用。
          void running.catch(() => {
            countCache.delete(key);
          });
        }
        return running;
      },
    },
    meta: {
      /**
       * Oldest message sendTime (unix seconds) across c2c + group tables, or
       * null when the account has no stored messages at all. Drives the
       * 「历史以来」span denominator. Two MIN scans, cached by the engine.
       */
      oldestMessageTime,
      /**
       * The years the account actually sent something in — the selectable
       * report years. Two DISTINCT-year scans, cached here for the session.
       */
      sentYears,
    },
  };
}
