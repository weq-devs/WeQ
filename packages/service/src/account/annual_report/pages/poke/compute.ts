import type { PageAvailability, PageComputeCtx, ReportPageDefinition } from '../../types';
import { reportYearUnixRange } from '../../time';
import { loadGroupNames, personWithName } from '../interaction-shared';
import type { PokePageData } from './types';

/**
 * 戳一戳 —— 一页只讲「隔着屏幕的那一下」。
 *
 * 资格：戳出去或被戳，任一方向有数据就成立；两边都是 0 就把这页摘掉。
 * 数据复用 db 层同一次 `interactionTally` 扫描里的 poke / pokeMe 两组。
 */
export const pokePage: ReportPageDefinition<PokePageData> = {
  manifest: {
    id: 'poke',
    title: '戳一戳',
    description: '戳一戳与被戳一戳——最轻的搭话，隔着屏幕先伸手。',
    order: 10,
    version: '0.1.0',
    apiVersion: 1,
    category: '群聊',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tally = await q.group.interactionTally(startSec, endSec);
    const has = tally.poke.total > 0 || tally.pokeMe.total > 0;
    return {
      available: has,
      reason: has ? undefined : '这一年没有可统计的戳一戳',
    };
  },
  compute: async ({ year, q }: PageComputeCtx): Promise<PokePageData> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tally = await q.group.interactionTally(startSec, endSec);
    const groupNameOf = await loadGroupNames(q, [
      tally.poke.top?.groupCode,
      tally.pokeMe.top?.groupCode,
    ]);
    const [pokeTop, pokeMeTop] = await Promise.all([
      personWithName(q, tally.poke.top, groupNameOf),
      personWithName(q, tally.pokeMe.top, groupNameOf),
    ]);
    return {
      year,
      pokeTotal: tally.poke.total,
      pokeTop,
      pokeMeTotal: tally.pokeMe.total,
      pokeMeTop,
    };
  },
};
