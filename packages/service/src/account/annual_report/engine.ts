import type { AccountSession } from '@weq/account';
import { AnnualReportCache, scopeKey } from './cache';
import { createReportQueries } from './queries';
import { ALL_TIME_YEAR, currentReportYear, normalizeReportYear } from './time';
import { findReportPage, reportPages } from './pages';
import {
  DEFAULT_REPORT_SCOPE,
  type AnnualReportPreferences,
  type DressNameResolver,
  type PageAvailability,
  type ReportManifest,
  type ReportPageDefinition,
  type ReportPageError,
  type ReportPageResult,
  type ReportScope,
  type ReportQzoneCapability,
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
  /**
   * 装扮款名解析器（可选）。名字的两个来源（账号已装清单 / 仓库静态商城榜单）都在
   * service 之外，所以由宿主注入；不注入时装扮页照常出，只是显示 `#itemId`。
   */
  resolveDressNames?: DressNameResolver;
  /**
   * 系统表情 faceId → 干净中文名的解析器（宿主从账号 emoji.db 读）。不注入时
   * 「我的话」页照常出，表情名退到消息自带 faceText / 「表情 N」。
   */
  resolveEmojiNames?: (faceIds: number[]) => Promise<Record<number, string>>;
  /**
   * QQ 空间回忆的在线读能力。离线 / 静态账号不注入 —— 该页 availability 恒不
   * 通过，deck 里自然没有这一页。
   */
  qzone?: ReportQzoneCapability;
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
    this.queries = createReportQueries(this.session, {
      resolveDressNames: options.resolveDressNames,
      resolveEmojiNames: options.resolveEmojiNames,
      qzone: options.qzone,
    });
    this.preferences = options.preferences ?? DEFAULT_PREFERENCES;
  }

  /**
   * The selectable report periods: every year the account has any c2c or group
   * message row in, ascending, then `ALL_TIME_YEAR` at the far right.
   *
   * Deliberately not `[earliest..currentYear]` — that span invented years the
   * account was silent in. Years are derived from the indexed day column
   * 40058 (any message at all, no self-sent judgement), so the entry page
   * never pays for a sender-aware full-table scan. Whether a chosen year has
   * pages worth showing is decided lazily per page by `getPageData`; an
   * account with no message rows at all gets `[]` and the entry page says so.
   */
  async getAvailableYears(): Promise<number[]> {
    if (this.availableYearsCache?.key === this.dataRevision) {
      return this.availableYearsCache.years;
    }
    const yearsWithMessages = await this.queries.meta.yearsWithMessages();
    const nowYear = currentReportYear();
    const years =
      yearsWithMessages.length === 0
        ? []
        : [...yearsWithMessages.filter((year) => year <= nowYear + 1), ALL_TIME_YEAR];
    this.availableYearsCache = { key: this.dataRevision, years };
    return years;
  }

  /**
   * The period to open on when the caller didn't name one: the most recent year
   * with data, or 「历史以来」 for an account with none. `getAvailableYears` is
   * ascending with `ALL_TIME_YEAR` pinned last, so the default is the largest
   * real year — not the list tail.
   */
  async getDefaultYear(): Promise<number> {
    const years = await this.getAvailableYears();
    const latest = years.filter((year) => year !== ALL_TIME_YEAR).pop();
    return latest ?? ALL_TIME_YEAR;
  }

  /**
   * Lightweight directory: 只返回“候选页”和年份，不逐页探测数据资格。
   *
   * 资格探测（`availability`）曾经在这里提前跑，等于刚选完年份就把每一页的
   * 全表统计都预热了一遍，页面越多越慢。现在把它挪到 `getPageData`：只有某页
   * 真正要算的时候才检查资格并计算，未命中的页以 `unavailable` 返回，渲染层
   * 再把它从 deck 摘掉 —— 这才是“小页在前、大页在后”能成立的懒加载。
   */
  async getManifest(year?: number): Promise<ReportManifest> {
    // 没指定年份时不再默认「今年」—— 今年可能一条都没发过。落到最近一个真的
    // 有数据的年份，账号完全没有数据时落到「历史以来」（页面集会是空的）。
    const availableYears = await this.getAvailableYears();
    const normalizedYear =
      year === undefined ? await this.getDefaultYear() : normalizeReportYear(year);
    const candidates = this.resolveCandidates();
    return {
      year: normalizedYear,
      availableYears,
      scope: this.scope,
      pages: candidates.map((page) => page.manifest),
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
      // 资格与数据一起惰性计算：不在 manifest 阶段预扫，翻/预取到这一页才算。
      if (page.availability) {
        const availability = await this.checkAvailability(year, page);
        if (!availability.available) {
          const unavailable: ReportPageResult = {
            pageId,
            version,
            status: 'unavailable',
            data: null,
            reason: availability.reason,
          };
          if (cacheable) this.cache.setPage(key, unavailable);
          return unavailable;
        }
      }
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
   * later `getPageData` on the same page doesn't re-run the database scan.
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
