import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { getAppContext, type AccountServices } from '../../context/app_context';
import type { AnnualReportPreferences } from '@weq/service';
import { getHost } from '@weq/service';
import {
  renderLongImagePng,
  renderPdfFromHtml,
  type ReportExportSlide,
} from '../../annual_report_export';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const services = getAppContext().services;
  if (!services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return services;
}

const exportSlideInput = z.object({
  pageId: z.string().min(1),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  data: z.unknown(),
});

/** 保存对话框 + 落盘；用户取消返回 null。 */
async function saveBuffer(
  bytes: Buffer,
  defaultName: string,
  extension: string,
): Promise<string | null> {
  const target = await getHost().pickSaveTarget({ defaultName, extension });
  if (!target) return null;
  await writeFile(target.path, bytes);
  return target.path;
}

export const annualReportRouter = router({
  /** Lightweight directory; page payloads are loaded separately. */
  getManifest: procedure
    .input(z.object({ year: z.number().int().optional() }).optional())
    .query(({ input }) => requireServices().annualReport.getManifest(input?.year)),

  /** The selectable years [earliest message year .. current year]. */
  getAvailableYears: procedure.query(() => requireServices().annualReport.getAvailableYears()),

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

  /** 导出为自包含 HTML（保存到用户选择的位置）。 */
  exportHtml: procedure
    .input(z.object({ year: z.number().int(), html: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const path = await saveBuffer(
        Buffer.from(input.html, 'utf8'),
        `QQ年度报告_${input.year}.html`,
        'html',
      );
      return { saved: path != null, path };
    }),

  /** 把同一份 HTML 渲染成 A4 PDF 保存。 */
  exportPdf: procedure
    .input(z.object({ year: z.number().int(), html: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const pdf = await renderPdfFromHtml(input.html);
      const path = await saveBuffer(pdf, `QQ年度报告_${input.year}.pdf`, 'pdf');
      return { saved: path != null, path };
    }),

  /** 全部卡片竖排成一张 9:16 长图 PNG 保存。 */
  exportLongImage: procedure
    .input(
      z.object({
        year: z.number().int(),
        /** 账号最早有记录的年份，决定「历史以来 / xxxx 年」文案。 */
        startYear: z.number().int().optional(),
        slides: z.array(exportSlideInput).min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const slides: ReportExportSlide[] = input.slides.map((s) => ({
        pageId: s.pageId,
        title: s.title,
        description: s.description,
        category: s.category,
        data: s.data,
      }));
      const png = await renderLongImagePng(slides, input.startYear ?? input.year);
      const path = await saveBuffer(png, `QQ年度报告_${input.year}_长图.png`, 'png');
      return { saved: path != null, path };
    }),
});
