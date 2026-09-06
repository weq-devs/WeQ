import type { AccountSession } from '@weq/account';
import { AnnualReportCache, scopeKey } from './cache';
import { createReportQueries } from './queries';
import { ALL_TIME_YEAR, currentReportYear, normalizeReportYear } from './time';
import { findReportPage, reportPages } from './pages';
import {
  DEFAULT_REPORT_SCOPE,
  type AnnualReportPreferences,
  type PageAvailability,
  type ReportManifest,
  type ReportPageDefinition,
  type ReportPageError,
  type ReportPageResult,
  type ReportScope,
} from './types';

const DEFAULT_PREFERENCES: AnnualReportPreferences = {
  mode: 'default',
  enabledPageIds: [],
  order: [],
  exportPageIds: [],
};

export type AnnualReportServiceOptions = {
  scope?: ReportScope;
  dataRevision?: string;
  preferences?: AnnualReportPreferences;
};

export class AnnualReportService {
  private readonly cache = new AnnualReportCache();
  /** One shared query surface: availability / compute / MIN share memoized scans. */
  private readonly queries: ReturnType<typeof createReportQueries>;
  private readonly scope: ReportScope;
  private readonly dataRevision: string;
  private preferences: AnnualReportPreferences;
  /** Memoized selectable periods; keyed by dataRevision. */
  private availableYearsCache: { key: string; years: number[] } | null = null;

  constructor(
    private readonly session: AccountSession,
    options: AnnualReportServiceOptions = {},
  ) {
    this.scope = options.scope ?? DEFAULT_REPORT_SCOPE;
    this.dataRevision = options.dataRevision ?? session.msgDbPath;
    this.queries = createReportQueries(this.session);
    this.preferences = options.preferences ?? DEFAULT_PREFERENCES;
  }

  /**
   * The selectable report periods: `ALL_TIME_YEAR` first, then every year the
   * account actually *sent* a c2c or group message in, ascending.
   *
   * Deliberately not `[earliest..currentYear]` — that span invented years the
   * account was silent in, and every one of them opened an empty report. The
   * set now comes from two DISTINCT-year scans, cached for the session's data
   * revision. An account with no sent messages at all gets `[]`: there is no
   * period worth offering, and the entry page says so.
   */
  async getAvailableYears(): Promise<number[]> {
    if (this.availableYearsCache?.key === this.dataRevision) {
      return this.availableYearsCache.years;
    }
    const sent = await this.queries.meta.sentYears();
    const nowYear = currentReportYear();
    const years =
      sent.length === 0 ? [] : [ALL_TIME_YEAR, ...sent.filter((year) => year <= nowYear + 1)];
    this.availableYearsCache = { key: this.dataRevision, years };
    return years;
  }

  /**
   * The period to open on when the caller didn't name one: the most recent year
   * with data, or 「历史以来」 for an account with none.
   */
  async getDefaultYear(): Promise<number> {
    const years = await this.getAvailableYears();
    return years.length === 0 ? ALL_TIME_YEAR : (years[years.length - 1] as number);
  }

  /** Lightweight directory: manifest + per-page availability (probed & cached). */
  async getManifest(year?: number): Promise<ReportManifest> {
    // 没指定年份时不再默认「今年」—— 今年可能一条都没发过。落到最近一个真的
    // 有数据的年份，账号完全没有数据时落到「历史以来」（页面集会是空的）。
    const availableYears = await this.getAvailableYears();
    const normalizedYear =
      year === undefined ? await this.getDefaultYear() : normalizeReportYear(year);
    const candidates = this.resolveCandidates();
    const availability = await Promise.all(
      candidates.map((page) => this.checkAvailability(normalizedYear, page)),
    );
    const pages = candidates
      .filter((_, index) => availability[index]?.available)
      .map((page) => page.manifest);
    return {
      year: normalizedYear,
      availableYears,
      scope: this.scope,
      pages,
      availablePages: reportPages
        .slice()
        .sort((a, b) => a.manifest.order - b.manifest.order)
        .map((page) => page.manifest),
      preferences: this.preferences,
    };
  }

  setPreferences(preferences: AnnualReportPreferences): void {
    this.preferences = {
      mode: preferences.mode,
      enabledPageIds: [...preferences.enabledPageIds],
      order: [...preferences.order],
      exportPageIds: [...preferences.exportPageIds],
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getPageData(year: number, pageId: string): Promise<ReportPageResult> {
    const normalizedYear = normalizeReportYear(year);
    const page = findReportPage(pageId);
    if (!page) {
      return {
        pageId,
        version: 'unknown',
        status: 'error',
        data: null,
        error: this.error('UNKNOWN_PAGE', `找不到年度报告页面：${pageId}`, false),
      };
    }

    const key = [
      normalizedYear,
      page.manifest.id,
      page.manifest.version,
      scopeKey(this.scope),
      this.dataRevision,
    ].join('|');
    const cached = this.cache.getPage(key);
    if (cached) return cached;
    const running = this.cache.getInFlight(key);
    if (running) return running;

    const request = this.computePage(
      normalizedYear,
      pageId,
      page.manifest.version,
      key,
      page.cacheable !== false,
    );
    this.cache.setInFlight(key, request);
    void request.then(
      () => this.cache.deleteInFlight(key),
      () => this.cache.deleteInFlight(key),
    );
    return request;
  }

  private async computePage(
    year: number,
    pageId: string,
    version: string,
    key: string,
    cacheable: boolean,
  ): Promise<ReportPageResult> {
    try {
      const page = findReportPage(pageId);
      if (!page) throw new Error(`找不到年度报告页面：${pageId}`);
      const data = await page.compute({
        year,
        scope: this.scope,
        q: this.queries,
        signal: new AbortController().signal,
        dataRevision: this.dataRevision,
      });
      assertJsonSafe(data);
      const result: ReportPageResult = { pageId, version, status: 'ok', data };
      if (cacheable) this.cache.setPage(key, result);
      return result;
    } catch (error) {
      return {
        pageId,
        version,
        status: 'error',
        data: null,
        error: this.error(
          'COMPUTE_FAILED',
          error instanceof Error ? error.message : String(error),
          true,
        ),
      };
    }
  }

  /**
   * Cheap per-page eligibility probe. Results are memoized in memory so a
   * manifest refresh doesn't re-hit the database for every page.
   */
  private async checkAvailability(
    year: number,
    page: ReportPageDefinition,
  ): Promise<PageAvailability> {
    if (!page.availability) return { available: true };
    const key = [
      'avail',
      year,
      page.manifest.id,
      page.manifest.version,
      scopeKey(this.scope),
      this.dataRevision,
    ].join('|');
    const cached = this.cache.getAvailability(key);
    if (cached) return cached;
    const running = Promise.resolve(
      page.availability({
        year,
        scope: this.scope,
        q: this.queries,
        dataRevision: this.dataRevision,
      }),
    );
    this.cache.setAvailability(key, running);
    void running.then(
      () => this.cache.deleteAvailability(key),
      () => this.cache.deleteAvailability(key),
    );
    return running;
  }

  /** Preference-merged candidate page definitions, in display order. */
  private resolveCandidates(): ReportPageDefinition[] {
    const defaults = reportPages
      .filter((page) => page.manifest.enabledByDefault)
      .sort((a, b) => a.manifest.order - b.manifest.order);
    const visible =
      this.preferences.mode === 'custom'
        ? reportPages.filter((page) => this.preferences.enabledPageIds.includes(page.manifest.id))
        : defaults;
    const order = new Map(this.preferences.order.map((id, index) => [id, index]));
    return visible
      .slice()
      .sort(
        (a, b) =>
          (order.get(a.manifest.id) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(b.manifest.id) ?? Number.MAX_SAFE_INTEGER) ||
          a.manifest.order - b.manifest.order,
      );
  }

  private error(code: string, message: string, retryable: boolean): ReportPageError {
    return { code, message, retryable };
  }
}

export function defaultReportPreferences(): AnnualReportPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    enabledPageIds: [],
    order: [],
    exportPageIds: [],
  };
}

function assertJsonSafe(value: unknown, path = 'data'): void {
  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    throw new Error(`页面数据不是纯 JSON：${path}`);
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJsonSafe(item, `${path}[${index}]`);
    });
    return;
  }
  for (const [key, item] of Object.entries(value)) assertJsonSafe(item, `${path}.${key}`);
}

export function reportServiceCurrentYear(): number {
  return currentReportYear();
}
