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
  /** The report's period. `ALL_TIME_YEAR` (0) = 「历史以来」. */
  year: number;
  /**
   * Selectable periods, ascending, with `ALL_TIME_YEAR` (0) first when the
   * account has any data at all. Only years the account actually *sent* a
   * message in are listed — silent years have no report to show.
   */
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
 * report `available: true`, so data-ineligible pages (e.g. a year with no sent
 * messages) never enter the deck. The probe is a lightweight query — heavy
 * per-page computation still happens lazily via `getPageData`.
 */
export type PageAvailability = {
  available: boolean;
  reason?: string;
};

/**
 * Typed read-only query surface handed to page availability/compute hooks.
 * Created against the live `AccountSession`; pages never see the session,
 * a database handle or SQL.
 */
export type ReportQueries = {
  /**
   * Message-volume stats for the overview card. One pass per table, no body
   * decode — deliberately the cheapest global aggregates we can offer.
   */
  overview: {
    /**
     * Sent / received split for one half-open time window [startTime, endTime)
     * (unix seconds), across c2c + group tables only (dataline excluded).
     */
    countByDirection(
      startTime: number,
      endTime: number,
    ): Promise<{
      c2cSent: number;
      c2cReceived: number;
      groupSent: number;
      groupReceived: number;
    }>;
  };
  /** Engine-level metadata, not page data. */
  meta: {
    /**
     * Oldest message sendTime (unix seconds) across c2c + group tables, or
     * null when the account has no messages at all. The denominator anchor for
     * 「历史以来」per-day figures; the engine caches the result.
     */
    oldestMessageTime(): Promise<number | null>;
    /**
     * The local-time years in which the account sent at least one c2c or group
     * message, ascending. This — not the [oldest..now] span — is the set of
     * selectable report years: a year you never spoke in has no report.
     */
    sentYears(): Promise<number[]>;
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
