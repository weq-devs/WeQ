/** Shared contracts for the compile-time annual-report page system. */

export type ReportScope = {
  includeC2c: boolean;
  includeGroups: boolean;
  includeDataline: boolean;
  includeServiceAccounts: boolean;
};

export const DEFAULT_REPORT_SCOPE: ReportScope = {
  includeC2c: true,
  includeGroups: true,
  includeDataline: false,
  includeServiceAccounts: false,
};

export type ReportPageManifest = {
  id: string;
  title: string;
  description: string;
  order: number;
  version: string;
  apiVersion: number;
  category: string;
  enabledByDefault: boolean;
};

export type AnnualReportPreferences = {
  mode: 'default' | 'custom';
  enabledPageIds: string[];
  order: string[];
  exportPageIds: string[];
};

export type ReportManifest = {
  year: number;
  availableYears: number[];
  scope: ReportScope;
  /** Effective ordered page collection for browsing. */
  pages: ReportPageManifest[];
  /** All compiled-in pages, including disabled pages, for the DIY manager. */
  availablePages: ReportPageManifest[];
  preferences: AnnualReportPreferences;
};

export type ReportPageStatus = 'ok' | 'error';

export type ReportPageError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type ReportPageResult<D = unknown> = {
  pageId: string;
  version: string;
  status: ReportPageStatus;
  data: D | null;
  error?: ReportPageError;
};

export type MessageDigest = {
  timestamp: number;
  conversationId: string;
  senderName: string;
  preview: string;
};

export type YearStatsCore = {
  year: number;
  scope: ReportScope;
  totalMessages: number;
  activeDays: number;
  dailyCounts: Record<string, number>;
  hourlyCounts: Record<number, number>;
  messageTypeCounts: Record<string, number>;
  firstMessage: MessageDigest | null;
  lastMessage: MessageDigest | null;
};

export type ReportQueries = {
  /** Reserved typed query surface; populated as real database adapters land. */
  readonly available: false;
};

export type PageComputeCtx = {
  year: number;
  scope: ReportScope;
  core: YearStatsCore;
  q: ReportQueries;
  signal: AbortSignal;
  dataRevision: string;
};

export type ReportPageDefinition<D = unknown> = {
  manifest: ReportPageManifest;
  compute: (ctx: PageComputeCtx) => Promise<D>;
  cacheable?: boolean;
};
