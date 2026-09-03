import type { PageAvailability, ReportPageResult, ReportScope } from './types';

export function scopeKey(scope: ReportScope): string {
  return JSON.stringify(scope);
}

export class AnnualReportCache {
  private readonly pages = new Map<string, ReportPageResult>();
  private readonly inFlight = new Map<string, Promise<ReportPageResult>>();
  private readonly availability = new Map<string, Promise<PageAvailability>>();

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

  getAvailability(key: string): Promise<PageAvailability> | undefined {
    return this.availability.get(key);
  }

  setAvailability(key: string, value: Promise<PageAvailability>): void {
    this.availability.set(key, value);
  }

  deleteAvailability(key: string): void {
    this.availability.delete(key);
  }

  clear(): void {
    this.pages.clear();
    this.inFlight.clear();
    this.availability.clear();
  }
}
