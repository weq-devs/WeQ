import type { ReportPageDefinition } from '../types';

export type HeatmapPageData = {
  dailyCounts: Record<string, number>;
};

export const heatmapPage: ReportPageDefinition<HeatmapPageData> = {
  manifest: {
    id: 'heatmap',
    title: '全年热力图',
    description: '用一整年的日历，回看每一次留下消息的日子。',
    order: 30,
    version: '0.1.0',
    apiVersion: 1,
    category: 'activity',
    enabledByDefault: true,
  },
  compute: async ({ core }) => ({ dailyCounts: core.dailyCounts }),
};
