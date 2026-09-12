import type { PageAvailability, PageComputeCtx, ReportPageDefinition } from '../../types';
import { reportYearUnixRange } from '../../time';
import { groupTop, loadGroupNames, personWithName } from '../interaction-shared';
import type { AtPageData } from './types';

/**
 * @ 与被 @ —— 一页只讲「名字」。
 *
 * 资格：这一年至少要有一条指向具体成员的 @（我发出去或飞回来），两条都没有就把
 * 这页从 deck 里摘掉，而不是留一页空壳。
 *
 * 数据与另外两页同源：`interactionTally` 在 db 层一次扫完 @ / 戳 / 复读，这里只取
 * @ 的那两组，再给冠军补群名与人名。去重人数直接来自 tally（我 @ 过的不同 key 数、
 * 喊过我的不同发送者数）。
 */
export const atPage: ReportPageDefinition<AtPageData> = {
  manifest: {
    id: 'at',
    title: '@ 与被 @',
    description: '我 @ 过谁、谁在人群里喊过我的名字。',
    order: 9,
    version: '0.1.0',
    apiVersion: 1,
    category: '群聊',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tally = await q.group.interactionTally(startSec, endSec);
    const has = tally.at.total > 0 || tally.atMe.total > 0;
    return {
      available: has,
      reason: has ? undefined : '这一年没有可统计的 @ 与被 @',
    };
  },
  compute: async ({ year, q }: PageComputeCtx): Promise<AtPageData> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tally = await q.group.interactionTally(startSec, endSec);
    const groupNameOf = await loadGroupNames(q, [
      tally.at.top?.groupCode,
      tally.atMe.topGroup?.groupCode,
    ]);
    return {
      year,
      atTotal: tally.at.total,
      atPeople: tally.at.distinct,
      atTop: await personWithName(q, tally.at.top, groupNameOf),
      atMeTotal: tally.atMe.total,
      atMePeople: tally.atMe.distinct,
      atMeTop: groupTop(tally.atMe.topGroup, groupNameOf),
    };
  },
};
