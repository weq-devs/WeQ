import type { AccountSession } from '@weq/account';
import { DEFAULT_REPORT_SCOPE, type ReportScope, type YearStatsCore } from './types';
import { normalizeReportYear } from './time';

/**
 * Build the shared aggregate used by report pages.
 *
 * This first framework slice intentionally does not scan QQ databases yet. It
 * returns a valid empty aggregate so the page lifecycle, cache and IPC can be
 * exercised before statistics are added. The database adapter belongs here,
 * not in individual page components.
 */
export async function buildYearStatsCore(
  _session: AccountSession,
  year: number,
  scope: ReportScope = DEFAULT_REPORT_SCOPE,
): Promise<YearStatsCore> {
  const normalizedYear = normalizeReportYear(year);
  return {
    year: normalizedYear,
    scope,
    totalMessages: 0,
    activeDays: 0,
    dailyCounts: {},
    hourlyCounts: {},
    messageTypeCounts: {},
    firstMessage: null,
    lastMessage: null,
  };
}
