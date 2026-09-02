import type { ReportPageDefinition } from '../types';

export type HoursPageData = {
  hourlyCounts: Record<number, number>;
};

export const hoursPage: ReportPageDefinition<HoursPageData> = {
  manifest: {
    id: 'hours',
    title: '活跃时段',
    description: '一天中的哪些时刻，最容易打开 QQ 聊天。',
    order: 20,
    version: '0.1.0',
    apiVersion: 1,
    category: 'activity',
    enabledByDefault: true,
  },
  compute: async ({ core }) => ({ hourlyCounts: core.hourlyCounts }),
};
