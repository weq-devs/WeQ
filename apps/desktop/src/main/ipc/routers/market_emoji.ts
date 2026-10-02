/**
 * `account.marketEmoji.*` — browse the open account's market-face (store
 * sticker) cache (`nt_data/Emoji/marketface/*`). Thin tRPC skin over
 * `MarketEmojiResourceService` (see `@weq/service`). The image bytes are NOT
 * returned here — the renderer streams each file via the existing
 * `weq-media://mface?pack=<itemId>&hash=<hash>` protocol. Read-only.
 */

import { z } from 'zod';
import { join } from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { getHost, sanitizeSegment, uniqueName } from '@weq/service';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { searchCatalog } from '../../market_catalog';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

export const marketEmojiRouter = router({
  /** One page of market-face stickers (itemId + hash + detected MIME type). */
  listEntries: procedure
    .input(
      z.object({
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
      }),
    )
    .query(({ input }) => {
      return requireServices().marketEmoji.listEntries({
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),

  /**
   * 「我添加的商城表情包」清单（读 emoji.db 的 market_emoticon_package_table，
   * 按添加时间倒序）。仅本地元数据（packId / 名称 / 介绍 / 添加时间），来源
   * (feetype) 与表情列表由 getPackDetail 在线补全。
   */
  listPackages: procedure.query(() => {
    return requireServices().emoji.listMarketPackages();
  }),

  /**
   * 一个表情包的在线详情：拉 android.json 解析出来源(feetype) / 介绍 / 上架时间
   * / 表情列表(hash+名)。前端据此渲染来源徽章与表情网格。缺网/包不存在返回 null。
   */
  getPackDetail: procedure.input(z.object({ packId: z.string().min(1) })).query(({ input }) => {
    return requireServices().emoji.getMarketPackDetail(input.packId);
  }),

  /**
   * 恢复一个表情包的图片解密密钥。不给 timestamp → native 自动(读种子/爆破)；
   * 给 timestamp → 本地按 md5(str(ts))[:16] 派生（手动输入体验）。返回 key +
   * 时间戳 + 来源(xydata/brute-force/manual)，供信息条展示解密原理。
   */
  getPackKey: procedure
    .input(
      z.object({
        packId: z.string().min(1),
        timestamp: z.number().int().positive().optional(),
      }),
    )
    .query(({ input }) => {
      return requireServices().emoji.getMarketPackKey(input.packId, input.timestamp);
    }),

  /**
   * 商城表情目录离线搜索（读打包的 resources/emoji/market.csv 内存索引）。
   * 关键词匹配名称 + 介绍；feeTypes 按来源标签过滤；数值游标分页。不经账号会话、
   * 不联网 —— 供「导出中心 · 商城表情下载」挑包。
   */
  searchCatalog: procedure
    .input(
      z.object({
        keyword: z.string().optional(),
        feeTypes: z.array(z.enum(['free', 'paid', 'vip', 'svip', 'unknown'])).optional(),
        /** 只看「最新上架」：取目录尾部若干条并倒序（忽略 feeTypes）。 */
        latest: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
      }),
    )
    .query(({ input }) => {
      return searchCatalog({
        keyword: input.keyword,
        feeTypes: input.feeTypes,
        latest: input.latest,
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),

  /**
   * 一键下载一套商城表情到本地：弹目录选择框 → 拉表情列表 + 恢复密钥 → 并发解密
   * 每张 GIF 到 `<所选目录>/<包名>/`。返回落盘目录与成功/失败张数，供前端提示
   * 并可「打开文件夹」。与导出中心的任务式下载不同，这条是即点即得（不进任务列表）。
   */
  downloadPackToLocal: procedure
    .input(z.object({ packId: z.string().min(1), name: z.string().optional() }))
    .mutation(async ({ input }) => {
      const services = requireServices();
      const detail = await services.emoji.getMarketPackDetail(input.packId);
      if (!detail || detail.items.length === 0) {
        throw new Error('无法获取该表情包（网络问题或包不存在）');
      }
      const picked = await getHost().pickDirectory({ title: '选择商城表情保存文件夹' });
      if (!picked) return { ok: false as const, cancelled: true as const };

      const dirName = sanitizeSegment(input.name || detail.name, input.packId);
      const outDir = join(picked, dirName);
      await mkdir(outDir, { recursive: true });
      const key = (await services.emoji.getMarketPackKey(input.packId))?.key;

      const used = new Set<string>();
      let ok = 0;
      let failed = 0;
      const CONCURRENCY = 6;
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const idx = next++;
          const item = detail.items[idx];
          if (!item) return;
          try {
            const src = await services.emoji.getMarketPackImage(input.packId, item.hash, key);
            if (!src) throw new Error('解密或下载失败');
            const fileName = `${uniqueName(sanitizeSegment(item.name, item.hash), used)}.gif`;
            await copyFile(src, join(outDir, fileName));
            ok += 1;
          } catch {
            failed += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, detail.items.length) }, worker));
      return {
        ok: true as const,
        cancelled: false as const,
        dir: outDir,
        total: detail.items.length,
        downloaded: ok,
        failed,
      };
    }),

  /**
   * 批量下载选中的商城表情包：交给 ExportTaskManager 起一个独立下载任务
   * （并发解密 CDN 加密流 → GIF，按包名分文件夹），返回 taskId。任务进度与
   * 完成后另存都走下方「导出任务列表」的通用能力。
   */
  startDownload: procedure
    .input(
      z.object({
        packs: z
          .array(z.object({ id: z.string().min(1), name: z.string() }))
          .min(1)
          .max(200),
      }),
    )
    .mutation(({ input }) => {
      return requireServices().exportManager.startMarketPackDownload(input.packs);
    }),
});
