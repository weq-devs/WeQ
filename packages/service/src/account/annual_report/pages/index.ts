import type { ReportPageDefinition } from '../types';
import { intimacyPage } from './intimacy/compute';

/** The only service-side registration point for official report pages. */
export const reportPages: ReadonlyArray<ReportPageDefinition> = [intimacyPage];

export function findReportPage(pageId: string): ReportPageDefinition | undefined {
  return reportPages.find((page) => page.manifest.id === pageId);
}

export { intimacyPage };
