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
  /** Effective ordered page collection for browsing (data-eligible ∩ user preference). */
  pages: ReportPageManifest[];
  /** All compiled-in pages, including disabled / data-ineligible ones, for the DIY manager. */
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

/**
 * Whether a page qualifies for the account / year / scope.
 *
 * `getManifest` probes each candidate page cheaply and only exposes pages that
 * report `available: true`, so data-ineligible pages (e.g. no friends reach the
 * intimacy threshold) never enter the deck. The probe is a lightweight query —
 * heavy per-page computation still happens lazily via `getPageData`.
 */
export type PageAvailability = {
  available: boolean;
  reason?: string;
};

/** One friend row from the QQ profile intimacy ranking. */
export type IntimacyFriend = {
  uid: string;
  uin: string;
  nick: string;
  remark: string;
  intimacy: number;
};

/**
 * Typed read-only query surface handed to page availability/compute hooks.
 * Created against the live `AccountSession`; pages never see the session,
 * a database handle or SQL.
 */
export type ReportQueries = {
  intimacy: {
    /**
     * Friends whose QQ intimacy score is at least `minScore`, sorted 高→低,
     * at most `limit` rows.
     */
    listFriendsByIntimacy(minScore: number, limit: number): Promise<IntimacyFriend[]>;
    /**
     * Cheap existence probe for `getManifest`: does at least one friend reach
     * `minScore`? Sorted ranking means a single top-row fetch decides it.
     */
    hasFriendAtIntimacy(minScore: number): Promise<boolean>;
  };
};

export type PageComputeCtx = {
  year: number;
  scope: ReportScope;
  q: ReportQueries;
  signal: AbortSignal;
  dataRevision: string;
};

export type PageAvailabilityCtx = {
  year: number;
  scope: ReportScope;
  q: ReportQueries;
  dataRevision: string;
};

export type ReportPageDefinition<D = unknown> = {
  manifest: ReportPageManifest;
  /** Cheap eligibility probe run at manifest time. Absent = always available. */
  availability?: (ctx: PageAvailabilityCtx) => Promise<PageAvailability>;
  compute: (ctx: PageComputeCtx) => Promise<D>;
  cacheable?: boolean;
};
