import type { AccountSession } from '@weq/account';
import { AnnualReportCache, scopeKey } from './cache';
import { buildYearStatsCore } from './core';
import { createReportQueries } from './queries';
import { currentReportYear, normalizeReportYear } from './time';
import { findReportPage, reportPages } from './pages';
import {
  DEFAULT_REPORT_SCOPE,
  type AnnualReportPreferences,
  type ReportManifest,
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
  private readonly scope: ReportScope;
  private readonly dataRevision: string;
  private preferences: AnnualReportPreferences;

  constructor(
    private readonly session: AccountSession,
    options: AnnualReportServiceOptions = {},
  ) {
    this.scope = options.scope ?? DEFAULT_REPORT_SCOPE;
    this.dataRevision = options.dataRevision ?? session.msgDbPath;
    this.preferences = options.preferences ?? DEFAULT_PREFERENCES;
  }

  getManifest(year?: number): ReportManifest {
    const normalizedYear = normalizeReportYear(year);
    const pages = this.resolvePages();
    const availableYears = [normalizedYear];
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
      const coreKey = [year, scopeKey(this.scope), this.dataRevision].join('|');
      let corePromise = this.cache.getCore(coreKey);
      if (!corePromise) {
        corePromise = buildYearStatsCore(this.session, year, this.scope);
        this.cache.setCore(coreKey, corePromise);
        void corePromise.catch(() => {
          if (this.cache.getCore(coreKey) === corePromise) this.cache.deleteCore(coreKey);
        });
      }
      const core = await corePromise;
      const page = findReportPage(pageId);
      if (!page) throw new Error(`找不到年度报告页面：${pageId}`);
      const data = await page.compute({
        year,
        scope: this.scope,
        core,
        q: createReportQueries(),
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

  private resolvePages() {
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
      )
      .map((page) => page.manifest);
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
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) assertJsonSafe(item, `${path}.${key}`);
}

export function reportServiceCurrentYear(): number {
  return currentReportYear();
}
