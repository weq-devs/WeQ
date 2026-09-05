import type { PageAvailability, ReportPageDefinition } from '../../types';
import { reportYearUnixRange } from '../../time';
import type { EndPageData } from './types';

/**
 * 结尾页 —— 收尾的「谢谢观看」+ 导出入口。不依赖任何统计，compute 零查询，
 * 只是把年份带过去给渲染层做文案。
 *
 * availability 与 overview 同条件（这一年发过消息）：没数据的年份整份报告
 * 都不生成，避免出现「只有一张结尾页」的残缺 deck —— 入口页会拦截并提示。
 */
export const endPage: ReportPageDefinition<EndPageData> = {
  manifest: {
    id: 'end',
    title: '这一年，辛苦了',
    description: '你的 {year} 年度报告，到此结束。',
    order: 999,
    version: '0.1.0',
    apiVersion: 1,
    category: '结尾',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const counts = await q.overview.countByDirection(startSec, endSec);
    const hasSent = counts.c2cSent + counts.groupSent > 0;
    return {
      available: hasSent,
      reason: hasSent ? undefined : '这一年你没有发出任何消息',
    };
  },
  compute: async ({ year }) => ({ year }),
};
