import type { AccountSession } from '@weq/account';
import type { ReportQueries } from './types';

/**
 * Create the typed query capability passed to page compute / availability hooks.
 *
 * The surface is deliberately small and typed: pages get read-only, account-bound
 * queries and never touch `AccountSession`, a database handle or raw SQL.
 */
export function createReportQueries(session: AccountSession): ReportQueries {
  // 自己的 uin 从 c2c 数据本身推断（见 C2cMsgDb.inferSelfUin）：c2c 里
  // senderUid != targetUid 的行就是「我发的」，其 40033 众数即自己的 uin。
  // 这比 session/profile 里的身份更可靠 —— 实测 profile_info_v6 的 self 行
  // 可能指向别的联系人，导致 group 方向计数全零。推断一次后缓存。
  let selfUin: bigint | null | undefined; // undefined = 尚未解析
  async function resolveSelfUin(): Promise<bigint | null> {
    if (selfUin === undefined) {
      const inferred = await session.c2cMsgs.inferSelfUin();
      // context.uin 是字符串；Number() 先兜底空串（BigInt('') 会抛）。
      selfUin = inferred ?? BigInt(Number(session.context.uin) || 0);
    }
    return selfUin;
  }

  return {
    overview: {
      /**
       * Sent / received split for one time window, one pass per table. Only
       * real private chats (c2c_msg_table) and group chats (group_msg_table)
       * are counted — dataline / service tables are never queried here.
       */
      async countByDirection(startTime: number, endTime: number) {
        const [c2c, group] = await Promise.all([
          // c2c 方向由行内数据自证（senderUid != targetUid），无需 selfUin。
          session.c2cMsgs.countByDirection({ startTime, endTime }),
          session.groupMsgs.countByDirection({
            startTime,
            endTime,
            selfUin: (await resolveSelfUin()) ?? 0n,
          }),
        ]);
        return {
          c2cSent: c2c.sent,
          c2cReceived: c2c.received,
          groupSent: group.sent,
          groupReceived: group.received,
        };
      },
    },
    meta: {
      /**
       * Oldest message sendTime (unix seconds) across c2c + group tables, or
       * null when the account has no stored messages at all. Drives the first
       * selectable report year. Two MIN scans, cached by the engine.
       */
      async oldestMessageTime(): Promise<number | null> {
        const [c2c, group] = await Promise.all([
          session.c2cMsgs.oldestSendTime(),
          session.groupMsgs.oldestSendTime(),
        ]);
        const candidates = [c2c, group].filter((v): v is bigint => v != null && v > 0n);
        if (candidates.length === 0) return null;
        return Number(candidates.reduce((a, b) => (a < b ? a : b)));
      },
    },
  };
}
