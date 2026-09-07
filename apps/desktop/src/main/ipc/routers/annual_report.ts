import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { getAppContext, type AccountServices } from '../../context/app_context';
import type { AnnualReportPreferences, ResolvedMsgDecoration } from '@weq/service';
import { getHost } from '@weq/service';
import { reportPeriodLabel } from '@weq/service/report-time';
import { renderLongImagePng, renderSharePngs, type ReportExportSlide } from '../../annual_report_export';
import { procedure, router } from '../trpc';

/** 说说一次最多带 9 张图 —— 超出的页数在 router 层直接拒绝。 */
const QZONE_MAX_IMAGES = 9;

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
  /**
   * Lightweight directory; page payloads are loaded separately.
   * `year` omitted = 让服务端挑开屏口径（最近一个真的有数据的年份）；
   * `year: 0`（`ALL_TIME_YEAR`）= 历史以来。
   */
  getManifest: procedure
    .input(z.object({ year: z.number().int().min(0).optional() }).optional())
    .query(({ input }) => requireServices().annualReport.getManifest(input?.year)),

  /** 可选口径：`0`（历史以来）+ 发出过至少一条消息的年份。 */
  getAvailableYears: procedure.query(() => requireServices().annualReport.getAvailableYears()),

  /** Compute one page in the main process; failures stay isolated to this page. */
  getPageData: procedure
    .input(z.object({ year: z.number().int().min(0), pageId: z.string().min(1) }))
    .query(({ input }) => requireServices().annualReport.getPageData(input.year, input.pageId)),

  /**
   * 批量解析装扮资源，给「最喜欢的装扮」页预热。
   *
   * 复用 `msgDecoration.resolve` 的三条链（气泡九宫格 / 字体 ttf / 挂件帧动画），
   * 一次把整页要画的款全部拉齐 —— 前端在总览页停留时就该调它，翻到装扮页时资源
   * 已经在本地。
   *
   * **失败一律是静默的**：单款解析不出来（本地没缓存 + 没有在线实例 + 下载失败）
   * 就在结果里缺席，前端画占位。年度报告是「打开就看」的东西，不该因为一款气泡
   * 拉不到就弹「请登录 QQ 客户端」——那类提示属于装扮商城页，不属于这里。
   */
  prefetchDress: procedure
    .input(
      z.object({
        bubbles: z.array(z.number().int().positive()).max(60).default([]),
        fonts: z.array(z.number().int().positive()).max(60).default([]),
        widgets: z.array(z.number().int().positive()).max(60).default([]),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireServices();

      /**
       * 逐款解析并把成功的收进 `{itemId: value}`。`kind` 决定喂给
       * `msgDecoration.resolve` 的哪个字段（另外两个传 0，那条链就不会被触发）。
       * 单款失败 → 该 id 在结果里缺席，不抛。
       */
      async function resolveAll<T>(
        kind: 'bubbleId' | 'fontId' | 'widgetId',
        ids: number[],
        pick: (r: ResolvedMsgDecoration) => T | null | undefined,
      ): Promise<Record<number, T>> {
        const settled = await Promise.all(
          ids.map(async (id) => {
            try {
              const resolved = await services.msgDecoration.resolve({
                bubbleId: kind === 'bubbleId' ? id : 0,
                fontId: kind === 'fontId' ? id : 0,
                widgetId: kind === 'widgetId' ? id : 0,
              });
              return [id, pick(resolved)] as const;
            } catch {
              return [id, null] as const;
            }
          }),
        );
        const out: Record<number, T> = {};
        for (const [id, value] of settled) if (value != null) out[id] = value;
        return out;
      }

      const [bubbles, fonts, widgets] = await Promise.all([
        resolveAll('bubbleId', input.bubbles, (r) => r.bubble),
        // 字体只需要「拿到了没有」——ttf 路径在主进程，渲染走 weq-media://dressfont。
        resolveAll('fontId', input.fonts, (r) => (r.fontFile ? true : null)),
        resolveAll('widgetId', input.widgets, (r) => r.widget),
      ]);
      return { bubbles, fonts, widgets };
    }),

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
    .input(z.object({ year: z.number().int().min(0), html: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const path = await saveBuffer(
        Buffer.from(input.html, 'utf8'),
        `QQ年度报告_${reportPeriodLabel(input.year)}.html`,
        'html',
      );
      return { saved: path != null, path };
    }),

  /** 把同一份 HTML 渲染成 A4 PDF 保存。 */
  exportPdf: procedure
    .input(z.object({ year: z.number().int().min(0), html: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const pdf = await getHost().renderHtmlToPdf(input.html);
      const path = await saveBuffer(pdf, `QQ年度报告_${reportPeriodLabel(input.year)}.pdf`, 'pdf');
      return { saved: path != null, path };
    }),

  /** 全部卡片竖排成一张 9:16 长图 PNG 保存。 */
  exportLongImage: procedure
    .input(
      z.object({
        year: z.number().int().min(0),
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
      const png = await renderLongImagePng(slides);
      const path = await saveBuffer(
        png,
        `QQ年度报告_${reportPeriodLabel(input.year)}_长图.png`,
        'png',
      );
      return { saved: path != null, path };
    }),

  /**
   * 一键分享到 QQ 空间 —— 逐页渲染成 PNG（一页一图，不用长图），逐张上传到
   * Qzone 图床，最后以一条带图说说发表到本账号的空间。
   *
   * 凭证走 webQuery 的 qzone.qq.com 通路（p_skey 可由 ptlogin2 本地快速登录兑
   * 换，无需注入），票据失效自动换票重试一次。文案允许用户改；图片不可改。
   * 发表是主动写行为 —— 这里不做重试轰炸，失败原样上抛给前端提示。
   */
  shareQzone: procedure
    .input(
      z.object({
        year: z.number().int().min(0),
        content: z.string().min(1).max(2000),
        slides: z.array(exportSlideInput).min(1).max(9),
        ugcRight: z.union([z.literal(1), z.literal(4), z.literal(64)]).default(1),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireServices();

      if (input.slides.length > QZONE_MAX_IMAGES) {
        throw new Error(`说说一次最多 ${QZONE_MAX_IMAGES} 张图，当前选了 ${input.slides.length} 页`);
      }

      // 分享者信息：昵称 + 头像字节（主进程直接读本地头像缓存，离线也能画）。
      const profile = await services.profile.getSelfProfile();
      const nick = profile?.nick ?? '';
      let avatar: Buffer | undefined;
      try {
        const uin = profile?.uin != null ? String(profile.uin) : '';
        const path = uin
          ? (await services.avatarResource.resolveByUin('user', uin, 'big')) ??
            (await services.avatarResource.resolveByUin('user', uin, 'small'))
          : null;
        if (path) avatar = await readFile(path);
      } catch {
        avatar = undefined; // 头像缺席 → 卡片画首字兜底，不阻断分享。
      }

      // 1. 逐页渲染 PNG（一页一图）。
      const slides: ReportExportSlide[] = input.slides.map((s) => ({
        pageId: s.pageId,
        title: s.title,
        description: s.description,
        category: s.category,
        data: s.data,
      }));
      const pngs = await renderSharePngs(slides, {
        nick,
        avatar,
        initial: nick.slice(0, 1) || '我',
      });

      // 2. 逐张上传到 Qzone 图床，收集 richval。单张失败明确指出是第几张。
      const richvals: string[] = [];
      for (let i = 0; i < pngs.length; i++) {
        try {
          const upload = await services.webQuery.uploadQzoneImage(pngs[i]!.toString('base64'));
          richvals.push(upload.richval);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`第 ${i + 1} 张图片上传失败：${message}`);
        }
      }

      // 3. 发表说说（richvals 内部用 \t 拼接）。
      const published = await services.webQuery.publishQzone(
        input.content,
        richvals,
        input.ugcRight,
      );
      return { tid: published.tid, time: published.time, images: pngs.length };
    }),
});
