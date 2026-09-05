import type { PageAvailability, ReportPageDefinition } from '../../types';
import { reportYearUnixRange } from '../../time';
import type { OverviewPageData } from './types';

/**
 * 年度总览 —— 报告的第一页，也是唯一要求「开屏即出」的页面。
 *
 * 数据面刻意最小：全库（c2c + group）一年内按方向（我发/我收）各一次扫描，
 * 不碰消息体。统计范围只有私聊 + 群聊，**不含数据线**。
 *
 * 展示条件（态度表达：卡片是依据你的数据动态生成的）：
 * 私发或群发消息至少有一个不为零才展示本页 —— 如果这一年你一条都没发过，
 * 这页没有意义，直接不出现在 deck 里。
 */
export const overviewPage: ReportPageDefinition<OverviewPageData> = {
  manifest: {
    id: 'overview',
    title: '年度总览',
    description: '这一年你说了多少话，发给了谁。',
    order: 1,
    version: '0.1.0',
    apiVersion: 1,
    category: '总览',
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
  compute: async ({ year, q }) => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const counts = await q.overview.countByDirection(startSec, endSec);
    const data: OverviewPageData = {
      year,
      totalSent: counts.c2cSent + counts.groupSent,
      totalReceived: counts.c2cReceived + counts.groupReceived,
      c2cSent: counts.c2cSent,
      groupSent: counts.groupSent,
      c2cReceived: counts.c2cReceived,
      groupReceived: counts.groupReceived,
    };
    return data;
  },
};
