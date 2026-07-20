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
});
