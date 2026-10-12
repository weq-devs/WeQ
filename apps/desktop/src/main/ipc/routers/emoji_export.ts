/**
 * `account.emojiPack.*` — 「导出中心 · 导出表情包」的数据源与启动入口。
 *
 * 两条来源策略不同（详见 `@weq/service` 的 emoji_export）：
 *   - own      自己的表情：emoji.db 收藏 + 本地 personal_emoji；缺原图用 CDN 补，
 *              补不到退缩略图；
 *   - received 收到的表情：扫描本地 emoji-recv；只有缩略图的用缩略图补一份。
 *
 * 图片字节不过 tRPC：预览走 `weq-media://cemoji`（本地文件）。启动导出起一个
 * ExportTaskManager 任务（`emojiscan` / `emojidownload` / `emojiwrite` 三段），
 * 进度与完成保存复用下方通用「导出任务列表」。
 */

import { z } from 'zod';
import {
  collectOwnItems,
  collectReceivedItems,
  type EmojiExportItem,
  type EmojiExportScope,
  type EmojiScopeSummary,
} from '@weq/service';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

const scopeEnum = z.enum(['own', 'received']);

/** 预览抽样条数上限（面板上的小格）。 */
const PREVIEW_SAMPLE = 12;

/** 一个来源的条目 → 统计 + 预览样本。 */
function summarize(scope: EmojiExportScope, items: EmojiExportItem[]): EmojiScopeSummary {
  let withOri = 0;
  let thumbOnly = 0;
  let downloadable = 0;
  let missing = 0;
  const sample: EmojiScopeSummary['sample'] = [];
  for (const it of items) {
    if (it.oriPath) withOri += 1;
    else if (it.thumbPath) thumbOnly += 1;
    else if (it.remoteUrl) downloadable += 1;
    else missing += 1;
    if (sample.length < PREVIEW_SAMPLE && it.preview) sample.push({ key: it.key, ...it.preview });
  }
  return { scope, total: items.length, withOri, thumbOnly, downloadable, missing, sample };
}

export const emojiPackRouter = router({
  /**
   * 面板首屏：两个来源的统计 + 预览样本。只读本地目录 / emoji.db，不下载。
   * `own` 需要活动会话的账号目录；静态账号同样能读本地收藏库。
   */
  summary: procedure.query(async () => {
    const services = requireServices();
    const ctx = getAppContext();
    const platform = ctx.resourcePlatform ?? ctx.platform;
    const uin = ctx.account?.context.uin ?? '';
    const own = await collectOwnItems(
      await services.emoji.listFavEmojiRows(),
      platform && uin ? platform.personalEmojiDir(uin) : null,
    );
    const received = await collectReceivedItems(
      platform && uin ? platform.emojiRecvDir(uin) : null,
    );
    return {
      own: summarize('own', own),
      received: summarize('received', received),
    };
  }),

  /**
   * 启动导出：给选中的来源起一个下载任务，返回 taskId。产物 = bundle 下的
   * 「我的表情 / 收到的表情」子目录，完成后在任务列表里「保存文件夹…」。
   */
  startExport: procedure
    .input(z.object({ scopes: z.array(scopeEnum).min(1) }))
    .mutation(({ input }) => {
      return requireServices().exportManager.startEmojiPackExport(input.scopes);
    }),
});
