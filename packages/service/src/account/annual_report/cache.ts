import type { ReportPageResult, ReportScope, YearStatsCore } from './types';

export function scopeKey(scope: ReportScope): string {
  return JSON.stringify(scope);
}

export class AnnualReportCache {
  private readonly core = new Map<string, Promise<YearStatsCore>>();
  private readonly pages = new Map<string, ReportPageResult>();
  private readonly inFlight = new Map<string, Promise<ReportPageResult>>();

  getCore(key: string): Promise<YearStatsCore> | undefined {
    return this.core.get(key);
  }

  setCore(key: string, value: Promise<YearStatsCore>): void {
    this.core.set(key, value);
  }

  deleteCore(key: string): void {
    this.core.delete(key);
  }

  getPage(key: string): ReportPageResult | undefined {
    return this.pages.get(key);
  }

  setPage(key: string, value: ReportPageResult): void {
    this.pages.set(key, value);
  }

  getInFlight(key: string): Promise<ReportPageResult> | undefined {
    return this.inFlight.get(key);
  }

  setInFlight(key: string, value: Promise<ReportPageResult>): void {
    this.inFlight.set(key, value);
  }

  deleteInFlight(key: string): void {
    this.inFlight.delete(key);
  }

  clear(): void {
    this.core.clear();
    this.pages.clear();
    this.inFlight.clear();
  }
}
