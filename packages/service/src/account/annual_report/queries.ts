import type { AccountSession } from '@weq/account';
import type { IntimacyFriend, ReportQueries } from './types';

/**
 * Create the typed query capability passed to page compute / availability hooks.
 *
 * The surface is deliberately small and typed: pages get read-only, account-bound
 * queries and never touch `AccountSession`, a database handle or raw SQL.
 */
export function createReportQueries(session: AccountSession): ReportQueries {
  return {
    intimacy: {
      async hasFriendAtIntimacy(minScore: number): Promise<boolean> {
        const [top] = await session.profileInfo.listFriendsByIntimacy(1, 0);
        return top ? top.intimacy >= minScore : false;
      },
      async listFriendsByIntimacy(minScore: number, limit: number): Promise<IntimacyFriend[]> {
        const result: IntimacyFriend[] = [];
        // listFriendsByIntimacy is sorted 高→低 already, so scan pages until we
        // hit a friend below the threshold or collect `limit` rows.
        const pageSize = 200;
        for (let offset = 0; result.length < limit; offset += pageSize) {
          const page = await session.profileInfo.listFriendsByIntimacy(pageSize, offset);
          if (page.length === 0) break;
          for (const friend of page) {
            if (friend.intimacy < minScore) return result;
            result.push(friend);
            if (result.length >= limit) return result;
          }
        }
        return result;
      },
    },
  };
}
