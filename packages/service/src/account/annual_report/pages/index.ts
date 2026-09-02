import type { ReportPageDefinition } from '../types';
import { heatmapPage } from './heatmap';
import { hoursPage } from './hours';
import { overviewPage } from './overview';

/** The only service-side registration point for official report pages. */
export const reportPages: ReadonlyArray<ReportPageDefinition> = [
  overviewPage,
  hoursPage,
  heatmapPage,
];

export function findReportPage(pageId: string): ReportPageDefinition | undefined {
  return reportPages.find((page) => page.manifest.id === pageId);
}

export { heatmapPage, hoursPage, overviewPage };
