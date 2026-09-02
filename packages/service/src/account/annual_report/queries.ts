import type { ReportQueries } from './types';

/**
 * Create the typed query capability passed to page compute functions.
 *
 * `available: false` is deliberate in the scaffold: pages cannot accidentally
 * reach AccountSession or a database. Concrete typed adapters will be added as
 * real page statistics are implemented.
 */
export function createReportQueries(): ReportQueries {
  return { available: false };
}
