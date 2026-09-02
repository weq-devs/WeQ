import type { ReportPageDefinition } from '../types';

export type OverviewPageData = {
  totalMessages: number;
  activeDays: number;
  firstMessage: unknown | null;
  lastMessage: unknown | null;
  messageTypeCounts: Record<string, number>;
};

export const overviewPage: ReportPageDefinition<OverviewPageData> = {
  manifest: {
    id: 'overview',
    title: '年度总览',
    description: '看看这一年的消息总量、活跃天数与首末记录。',
    order: 10,
    version: '0.1.0',
    apiVersion: 1,
    category: 'overview',
    enabledByDefault: true,
  },
  compute: async ({ core }) => ({
    totalMessages: core.totalMessages,
    activeDays: core.activeDays,
    firstMessage: core.firstMessage,
    lastMessage: core.lastMessage,
    messageTypeCounts: core.messageTypeCounts,
  }),
};
