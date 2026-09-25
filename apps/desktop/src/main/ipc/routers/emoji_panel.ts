/**
 * `account.emojiPanel.*` — 消息输入框表情面板的数据源。
 *
 * 全部读 emoji.db（`base_sys_emoji_table` 系统表情分类 / `emoji_com_used_table`
 * 最近使用 / `fav_emoji_info_storage_table` 收藏 / `related_emoji_emoji_table`
 * GIF 标签）+ `market_emoticon_package_table` 商城表情包。图片字节不过 tRPC：
 *   - 系统表情 → `weq-asset://emoji/<id>/apng/<id>.png`（缺资源自动下载补全）
 *   - 收藏     → `weq-media://cemoji?scope=&bucket=&v=&file=`
 *   - GIF      → `weq-media://relemoji?hash=<md5(关键词)>&file=<hash>.gif`
 *   - 商城表情 → `weq-media://mface?pack=&hash=&enc=tea`
 *
 * `recordRecent` 会写回 QQ 的 emoji.db（最近使用），是唯一有副作用的接口。
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

export const emojiPanelRouter = router({
  /** 面板首屏：系统表情分类 + 最近使用 + 收藏 + GIF 标签，一次性并发取回。 */
  overview: procedure.query(async () => {
    const emoji = requireServices().emoji;
    const [faces, recent, favorites, tags] = await Promise.all([
      emoji.listPanelFaces(),
      emoji.listRecentEmojis(),
      emoji.listFavoriteEmojis(),
      emoji.listRelatedTags(),
    ]);
    return { faces, recent, favorites, tags };
  }),

  /** 我添加的商城表情包清单（本地表）。 */
  marketPackages: procedure.query(() => {
    return requireServices().emoji.listMarketPackages();
  }),

  /** 单个商城表情包明细（在线优先，离线回退本地表）。 */
  marketPackDetail: procedure.input(z.object({ packId: z.string().min(1) })).query(({ input }) => {
    return requireServices().emoji.getMarketPackItems(input.packId);
  }),

  /** 某个 GIF 关键词标签下的全部 gif。 */
  relatedGifs: procedure.input(z.object({ keyword: z.string().min(1) })).query(({ input }) => {
    return requireServices().emoji.listRelatedGifs(input.keyword);
  }),

  /**
   * 把「刚使用的一个系统表情」写回 emoji_com_used_table（与 QQ 共用）。前端在
   * 选中 / 发送系统表情时调用；写入失败返回 false，不影响发送。
   */
  recordRecent: procedure
    .input(
      z.object({
        faceId: z.number().int().optional(),
        unicode: z.boolean().optional(),
        extra: z.string().optional(),
        sourceType: z.number().int().optional(),
      }),
    )
    .mutation(({ input }) => {
      return requireServices().emoji.recordRecentEmoji({
        faceId: input.faceId ?? 0,
        sourceType: input.sourceType ?? 0,
        unicode: input.unicode ?? false,
        extra: input.extra ?? '',
      });
    }),
});
