/**
 * 年度报告的时间口径与口径文案 —— 纯函数、零依赖，因此单独作为
 * `@weq/service/report-time` 子路径导出：renderer 只 type-import 主 barrel
 * （它会牵进 native/db），但屏幕版与三种导出产物必须共用同一份口径判定和
 * 文案，所以这个模块要能被真正 import 进浏览器包。
 */

/**
 * 「历史以来」的哨兵年份 —— 不是任何自然年，代表「全部时间」这一个可选项。
 *
 * 用 0 而不是另开一个 `year: number | 'all'` 联合类型：年份在 manifest /
 * IPC 输入 / 缓存 key / 页面数据里出现了十几处，全部改成联合类型会把
 * 「年份」这个概念摊薄到每一层；0 不可能是真实的消息年份（`sendTime > 0`
 * 才计入），语义空档正好留给它。判定一律走 {@link isAllTimeYear}。
 */
export const ALL_TIME_YEAR = 0;

export function isAllTimeYear(year: number): boolean {
  return year === ALL_TIME_YEAR;
}

export function currentReportYear(now = new Date()): number {
  return now.getFullYear();
}

export function normalizeReportYear(year: number | undefined, now = new Date()): number {
  const value = year ?? currentReportYear(now);
  if (isAllTimeYear(value)) return ALL_TIME_YEAR;
  if (!Number.isInteger(value) || value < 1970 || value > currentReportYear(now) + 1) {
    throw new Error(`无效的报告年份：${value}`);
  }
  return value;
}

/**
 * Local-time half-open range: [Jan 1 of year, Jan 1 of next year).
 * `null` for {@link ALL_TIME_YEAR} —— 全部时间没有边界。
 */
export function reportYearRange(year: number): { from: Date; to: Date } | null {
  if (isAllTimeYear(year)) return null;
  return {
    from: new Date(year, 0, 1, 0, 0, 0, 0),
    to: new Date(year + 1, 0, 1, 0, 0, 0, 0),
  };
}

/**
 * The same half-open year window as unix seconds — the SQL filter for counts.
 *
 * 「历史以来」返回 `{ startSec: 0, endSec: 0 }`：db 层的 `countByDirection`
 * 把 `<= 0` 的边界当作「不加这一侧的 WHERE」，于是 0/0 天然就是整表扫描，
 * 不需要在每个 page 里分支。
 */
export function reportYearUnixRange(year: number): { startSec: number; endSec: number } {
  const range = reportYearRange(year);
  if (!range) return { startSec: 0, endSec: 0 };
  return {
    startSec: Math.floor(range.from.getTime() / 1000),
    endSec: Math.floor(range.to.getTime() / 1000),
  };
}

/**
 * 口径的短标签：用在顶栏、导出文件名、页脚这些「一个词说清是哪段时间」的位置。
 */
export function reportPeriodLabel(year: number): string {
  return isAllTimeYear(year) ? '历史以来' : `${year}`;
}

/**
 * 正文里的时间状语 —— 「历史以来，你一共说出了…」/「2025 年，你一共说出了…」。
 * 屏幕版、HTML、PDF、长图共用这一个函数，四种产物的文案不会各自漂移。
 */
export function reportEraLabel(year: number): string {
  return isAllTimeYear(year) ? '历史以来' : `${year} 年`;
}

/**
 * 「历史以来」口径下的起点说明，例如「自 2017 年 7 月起」。没有最早时间
 * （空库）或自然年口径时返回空串，调用方直接拼接即可。
 */
export function reportSinceLabel(year: number, firstMessageTime: number | null): string {
  if (!isAllTimeYear(year) || firstMessageTime == null || firstMessageTime <= 0) return '';
  const date = new Date(firstMessageTime * 1000);
  return `自 ${date.getFullYear()} 年 ${date.getMonth() + 1} 月起`;
}

export function localDateKey(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 统计口径覆盖的天数 —— 日均类指标的分母。
 *
 * 自然年：往年算整年，当年只算到今天（不然 1 月的日均会被 365 天摊平）。
 * 历史以来：从最早一条消息当天算到今天。`oldestSec` 缺失时退回 1，
 * 让日均等于总数而不是除以 0。
 */
export function reportSpanDays(year: number, oldestSec: number | null, now = new Date()): number {
  if (isAllTimeYear(year)) {
    if (oldestSec == null || oldestSec <= 0) return 1;
    const days = (now.getTime() - oldestSec * 1000) / 86_400_000;
    return Math.max(1, Math.ceil(days));
  }
  if (year !== currentReportYear(now)) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 366 : 365;
  }
  const days = (now.getTime() - new Date(year, 0, 1).getTime()) / 86_400_000;
  return Math.max(1, Math.ceil(days));
}
