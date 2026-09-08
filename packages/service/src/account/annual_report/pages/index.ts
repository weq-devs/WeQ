import type { ReportPageDefinition } from '../types';
import { overviewPage } from './overview/compute';
import { dressPage } from './dress/compute';
import { sparkPage } from './spark/compute';
import { friendsPage } from './friends/compute';
import { openersPage } from './openers/compute';
import { rhythmPage } from './rhythm/compute';
import { voicePage } from './voice/compute';
import { homePage } from './home/compute';
import { interactionsPage } from './interactions/compute';
import { monthsPage } from './months/compute';
import { matePage } from './mate/compute';
import { endPage } from './end/compute';

/** The only service-side registration point for official report pages. */
export const reportPages: ReadonlyArray<ReportPageDefinition> = [
  overviewPage,
  dressPage,
  sparkPage,
  friendsPage,
  openersPage,
  rhythmPage,
  voicePage,
  homePage,
  interactionsPage,
  monthsPage,
  matePage,
  endPage,
];

export function findReportPage(pageId: string): ReportPageDefinition | undefined {
  return reportPages.find((page) => page.manifest.id === pageId);
}

export {
  overviewPage,
  dressPage,
  sparkPage,
  friendsPage,
  openersPage,
  rhythmPage,
  voicePage,
  homePage,
  interactionsPage,
  monthsPage,
  matePage,
  endPage,
};
