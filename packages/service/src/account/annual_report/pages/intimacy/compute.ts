import type { PageAvailability, ReportPageDefinition } from '../../types';
import type { IntimacyPageData } from './types';

/** 亲密度门槛：低于该分数则认为没有统计价值，页面不展示。 */
export const INTIMACY_MIN_SCORE = 1000;
/** 单页展示上限，防止整表好友全部达标时数据过大。 */
const INTIMACY_LIST_LIMIT = 50;

export const intimacyPage: ReportPageDefinition<IntimacyPageData> = {
  manifest: {
    id: 'intimacy',
    title: '亲密度最高的好友',
    description: '这一年里，和你亲密度最高的好友们。',
    order: 10,
    version: '0.1.0',
    apiVersion: 1,
    category: '好友',
    enabledByDefault: true,
  },
  /**
   * 数据不足门槛：没有任何好友亲密度 ≥ 1000 时页面不可用。
   * 该探测是单条 LIMIT 1 查询，manifest 阶段执行并缓存。
   */
  availability: async ({ q }): Promise<PageAvailability> => {
    const hasFriend = await q.intimacy.hasFriendAtIntimacy(INTIMACY_MIN_SCORE);
    return {
      available: hasFriend,
      reason: hasFriend ? undefined : `没有亲密度 ≥ ${INTIMACY_MIN_SCORE} 的好友`,
    };
  },
  compute: async ({ q }) => {
    const friends = await q.intimacy.listFriendsByIntimacy(INTIMACY_MIN_SCORE, INTIMACY_LIST_LIMIT);
    return {
      minScore: INTIMACY_MIN_SCORE,
      total: friends.length,
      friends,
    };
  },
};
