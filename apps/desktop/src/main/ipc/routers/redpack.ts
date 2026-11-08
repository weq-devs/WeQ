/**
 * `account.redpack.catalog` —— 个性装扮里「红包封面」展柜的离线目录。
 *
 * 数据源只有仓库里的 `resources/redpack/skins.json`（抓取脚本见
 * `scripts/fetch_red_pack_skins.ts`）：**不联网、不经账号会话、不要求 QQ 在线**。
 * 这样它和「聊天背景 / 浮屏挂件」一样属于纯本地一栏，任何账号状态下都能看。
 *
 * 图片本身仍走 `weq-media://redbag?id=<skinId>&v=<preview|popup|background|image>`：
 * 由主进程取字节并落盘缓存（`redpack` 子目录），渲染进程不直连 CDN，也就不必为它
 * 再放开一段 CSP。
 */

import { z } from 'zod';
import { listRedPackSkins, type RedPackSkinVariant } from '../../redpack_catalog';
import { procedure, router } from '../trpc';

/** 展柜卡片只需要这几个字段；图字段给的是**字段名**，渲染层自己去拼 media URL。 */
export interface RedPackSkinCard {
  id: number;
  name: string;
  /** 可用的图字段（可能为空数组 —— 目录里这一只没有任何图）。 */
  variants: RedPackSkinVariant[];
  jumpText: string;
  jumpUrl: string;
}

const VARIANTS: RedPackSkinVariant[] = ['preview', 'popup', 'background', 'image'];

export const redpackRouter = router({
  /**
   * 本地红包封面目录。`keyword` 为空时返回全部（按 id 升序）。
   *
   * 只做纯内存过滤 —— skins.json 首次访问解析一次，之后都走缓存。
   */
  catalog: procedure
    .input(z.object({ keyword: z.string().max(64).default('') }).default({ keyword: '' }))
    .query(({ input }) => {
      const result = listRedPackSkins(input.keyword);
      const skins: RedPackSkinCard[] = result.skins.map((skin) => ({
        id: skin.id,
        name: skin.name,
        variants: VARIANTS.filter((variant) => Boolean(skin[variant])),
        jumpText: skin.jumpText,
        jumpUrl: skin.jumpUrl,
      }));
      return {
        skins,
        /** 目录里的总条目数（不受 keyword 影响）。 */
        total: result.total,
        /** skins.json 的抓取时间（unix 秒），0 表示文件里没写。 */
        generatedAt: result.generatedAt,
      };
    }),
});
