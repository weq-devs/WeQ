import { z } from 'zod';
import { getAppContext, type AccountServices } from '../../context/app_context';
import type { AnnualReportPreferences } from '@weq/service';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const services = getAppContext().services;
  if (!services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return services;
}

export const annualReportRouter = router({
  /** Lightweight directory; page payloads are loaded separately. */
  getManifest: procedure
    .input(z.object({ year: z.number().int().optional() }).optional())
    .query(({ input }) => requireServices().annualReport.getManifest(input?.year)),

  /** Compute one page in the main process; failures stay isolated to this page. */
  getPageData: procedure
    .input(z.object({ year: z.number().int(), pageId: z.string().min(1) }))
    .query(({ input }) => requireServices().annualReport.getPageData(input.year, input.pageId)),

  /** Persist the user's page collection; changing it never invalidates page data. */
  setPreferences: procedure
    .input(
      z.object({
        mode: z.enum(['default', 'custom']),
        enabledPageIds: z.array(z.string().min(1)).max(100),
        order: z.array(z.string().min(1)).max(100),
        exportPageIds: z.array(z.string().min(1)).max(100),
      }),
    )
    .mutation(({ input }) => {
      const services = requireServices();
      const preferences: AnnualReportPreferences = {
        mode: input.mode,
        enabledPageIds: input.enabledPageIds,
        order: input.order,
        exportPageIds: input.exportPageIds,
      };
      services.annualReport.setPreferences(preferences);
      services.accountConfig.setAnnualReportPreferences(preferences);
      return services.annualReport.getManifest();
    }),
});
