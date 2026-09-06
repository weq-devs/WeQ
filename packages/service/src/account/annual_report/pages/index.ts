import type { ReportPageDefinition } from '../types';
import { overviewPage } from './overview/compute';
import { dressPage } from './dress/compute';
import { endPage } from './end/compute';

/** The only service-side registration point for official report pages. */
export const reportPages: ReadonlyArray<ReportPageDefinition> = [overviewPage, dressPage, endPage];

export function findReportPage(pageId: string): ReportPageDefinition | undefined {
  return reportPages.find((page) => page.manifest.id === pageId);
}

export { overviewPage, dressPage, endPage };
