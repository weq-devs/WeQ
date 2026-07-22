/**
 * `account.marketEmoji.*` — browse the open account's market-face (store
 * sticker) cache (`nt_data/Emoji/marketface/*`). Thin tRPC skin over
 * `MarketEmojiResourceService` (see `@weq/service`). The image bytes are NOT
 * returned here — the renderer streams each file via the existing
 * `weq-media://mface?pack=<itemId>&hash=<hash>` protocol. Read-only.
 */

import { z } from 'zod';
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
  getPackDetail: procedure
    .input(z.object({ packId: z.string().min(1) }))
    .query(({ input }) => {
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
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
      }),
    )
    .query(({ input }) => {
      return searchCatalog({
        keyword: input.keyword,
        feeTypes: input.feeTypes,
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
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
