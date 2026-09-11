import type { PageAvailability, PageComputeCtx, ReportPageDefinition } from '../../types';
import { reportYearUnixRange } from '../../time';
import { echoWithGroup, loadGroupNames } from '../interaction-shared';
import type { EchoPageData } from './types';

/**
 * 复读 —— 一页只讲「齐声」。
 *
 * 资格：这一年至少要有一次达标复读回合（长度 ≥ 4 且至少两个人），一次都没有就
 * 把这页摘掉 —— 比起摆一页「0 场」，不如干脆不出现在 deck 里。
 *
 * 数据复用 db 层同一次 `interactionTally` 扫描里的 echo 那一组：全群场次 / 条数、
 * 我参与的场数、我参与过的最长一轮、全群最长的一轮。
 */
export const echoPage: ReportPageDefinition<EchoPageData> = {
  manifest: {
    id: 'echo',
    title: '复读',
    description: '同一句话被接住了多少次——跟过的齐声，与最长的那一轮。',
    order: 11,
    version: '0.1.0',
    apiVersion: 1,
    category: '群聊',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tally = await q.group.interactionTally(startSec, endSec);
    const has = tally.echo.runs > 0 || tally.echo.participatedRuns > 0;
    return {
      available: has,
      reason: has ? undefined : '这一年没有可统计的复读回合',
    };
  },
  compute: async ({ year, q }: PageComputeCtx): Promise<EchoPageData> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tally = await q.group.interactionTally(startSec, endSec);
    const groupNameOf = await loadGroupNames(q, [
      tally.echo.mineLongest?.groupCode,
      tally.echo.longest?.groupCode,
    ]);
    return {
      year,
      runs: tally.echo.runs,
      messages: tally.echo.messages,
      participated: tally.echo.participatedRuns,
      mineLongest: echoWithGroup(tally.echo.mineLongest, groupNameOf),
      longest: echoWithGroup(tally.echo.longest, groupNameOf),
    };
  },
};
