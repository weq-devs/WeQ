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
import { OperationError } from '@weq/service';

import { z } from 'zod';
import { getAppContext, type AccountServices } from '../../context/app_context';
import type { SendMediaUploadReport } from '@weqbot/protocol';
import { elementsFromEditable } from '../serde';
import { procedure, router } from '../trpc';
import { recentReactions } from '../../recent_reactions';
import {
  resourceSourceInput,
  requireResourceSource,
  assertResourceSource,
} from './resource_source';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new OperationError(
      'No account session open — call bootstrap.openAccount first.',
      'expected',
    );
  }
  return ctx.services;
}

/**
 * 发送成功后把这张图记进「最近上传」。
 *
 * 失败（落盘出错 / 拿不到元数据）只记一条警告 —— 发送本身已经成功，不能因为
 * 索引写不进去就把整次发送报成失败。
 */
function recordRecentFromOutcome(
  services: AccountServices,
  outcome: { uploads?: SendMediaUploadReport[] },
  fileName?: string,
): void {
  const upload = outcome.uploads?.[0];
  if (!upload?.md5Hex) return;
  try {
    services.customEmojiRecent.record({
      md5: upload.md5Hex,
      fileName: fileName ?? upload.fileName,
      fileSize: upload.fileSize,
      // 上传报告不带尺寸/格式；「最近」列表只用来展示与去重，尺寸留 0 即可。
      width: 0,
      height: 0,
      picFormat: 1000,
    });
  } catch {
    // 索引不是关键路径。
  }
}

export const emojiPanelRouter = router({
  shortcuts: procedure.input(resourceSourceInput).query(async ({ input }) => {
    const services = requireResourceSource(input);
    const emoji = services.emoji;
    const [faces, recent] = await Promise.all([
      emoji.listShortcutFaces(),
      emoji.listRecentEmojis(),
    ]);
    assertResourceSource(services, input);
    return {
      faces,
      recent: recent.filter((item) => !item.unicode).map(({ id, usedAt }) => ({ id, usedAt })),
    };
  }),
  recentReactions: procedure.input(resourceSourceInput).query(({ input }) => {
    return recentReactions(requireResourceSource(input)).list();
  }),
  /** 系统表情和最近使用不等待收藏所在的文件目录和数据库表。 */
  catalog: procedure.query(async () => {
    const emoji = requireServices().emoji;
    const [faces, recent] = await Promise.all([emoji.listPanelFaces(), emoji.listRecentEmojis()]);
    return { faces, recent };
  }),
  favorites: procedure.query(() => requireServices().emoji.listFavoriteEmojis()),

  /** 保留原聚合读取供已有调用方使用；聊天面板分别读取。 */
  overview: procedure.query(async () => {
    const emoji = requireServices().emoji;
    const [faces, recent, favorites] = await Promise.all([
      emoji.listPanelFaces(),
      emoji.listRecentEmojis(),
      emoji.listFavoriteEmojis(),
    ]);
    return { faces, recent, favorites };
  }),

  /** 合并 WeQ 添加的整包与 QQ 已添加的整包。 */
  marketPackages: procedure.query(async () => {
    const services = requireServices();
    const local = await services.emoji.listMarketPackages();
    if (requireServices() !== services) throw new Error('账号已切换，请重新读取表情包');
    const added = getAppContext().bootstrap?.userConfig.read().composerMarketPacks ?? [];
    const packs = new Map(
      added.map(({ packId, name, summary }) => [packId, { packId, name, summary }]),
    );
    for (const { packId, name, summary } of local) {
      if (!packs.has(packId)) packs.set(packId, { packId, name, summary });
    }
    return [...packs.values()];
  }),

  /** WeQ 添加时保存目录快照，重开后可直接查看；QQ 已添加的包沿用原有链路。 */
  marketPackDetail: procedure.input(z.object({ packId: z.string().min(1) })).query(({ input }) => {
    const services = requireServices();
    const saved = getAppContext()
      .bootstrap?.userConfig.read()
      .composerMarketPacks?.find((pack) => pack.packId === input.packId);
    return saved
      ? { ...saved, count: saved.items.length, source: 'local' as const }
      : services.emoji.getMarketPackItems(input.packId);
  }),

  /** 某个 GIF 关键词标签下的全部 gif。 */
  relatedGifs: procedure.input(z.object({ keyword: z.string().min(1) })).query(({ input }) => {
    return requireServices().emoji.listRelatedGifs(input.keyword);
  }),

  /**
   * 把「刚使用的一个系统表情」写回 emoji_com_used_table（与 QQ 共用）。前端在
   * 选中 / 发送系统表情时调用；写入失败返回 false，不影响发送。
   */
  /**
   * QQ 秀 / 互动表情目录（按类型分组）。
   *
   * 数据来自 `resources/qqshow/show_emoji.json` 的离线快照 —— 服务端目录接口
   * `0x957b_0` 只对 Android appid 放行，PC 端拉不到。图标是 `iconUrl`（远程 PNG），
   * 渲染层直接加载，不经过 tRPC。
   */
  showEmojiCatalog: procedure.query(() => {
    return requireServices().showEmojiCatalog.groups();
  }),

  /** 自定义表情的「最近上传」索引（只含元数据，缩略图由渲染层按 md5 从缓存取）。 */
  customEmojiRecent: procedure.query(() => {
    return requireServices().customEmojiRecent.list();
  }),

  /**
   * 发一条自定义表情（普通图片形态，`businessType=20`）。
   *
   * `source` 是渲染层读出来的图片字节（IPC 安全的 Buffer 盒子），支持
   * JPG / PNG / GIF / WebP / BMP —— 格式由协议层按 magic 探测。
   */
  sendCustomEmoji: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        tempGroupCode: z.string().min(1).optional(),
        source: z.any(),
        fileName: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const source = elementsFromEditable(input.source) as Uint8Array;
      if (!(source instanceof Uint8Array) || source.byteLength === 0) {
        throw new Error('表情图片为空，无法发送。');
      }
      const services = requireServices();
      const outcome = await services.messageSend.sendMedia({
        peerType: input.peerType,
        targetId: input.targetId,
        ...(input.tempGroupCode ? { tempGroupCode: input.tempGroupCode } : {}),
        kind: 'image',
        source,
        subType: 1,
        summary: '[动画表情]',
        ...(input.fileName ? { fileName: input.fileName } : {}),
      });
      recordRecentFromOutcome(services, outcome, input.fileName);
      return outcome;
    }),

  /**
   * 发一条 QQ 秀 / 互动表情。
   *
   * 与自定义表情的差别只有两处：`businessType` 换成 10、`pic.11` 里补 `35/36`
   * （互动包定义，由目录里选中的 `packId` 拼出）。缺了 `35/36` 收端会回退成
   * 普通图片 —— 已用真机重放验证过。
   *
   * 私聊 / 群聊都收：两边的 reserve 都带 `35/36`，走同一条上传链路。
   */
  sendShowEmoji: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        /** 群临时会话的来源群号（会话行的 `60001`）。 */
        tempGroupCode: z.string().min(1).optional(),
        source: z.any(),
        /** 目录里的表情包 id（`iconUrl` 那格的 id）。 */
        packId: z.string().min(1),
        /** 变体下标（接龙类用它选关卡），缺省 0。 */
        variant: z.number().int().min(0).max(64).optional(),
        fileName: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const source = elementsFromEditable(input.source) as Uint8Array;
      if (!(source instanceof Uint8Array) || source.byteLength === 0) {
        throw new Error('表情图片为空，无法发送。');
      }
      const services = requireServices();
      const selfUin = services.accountConfig.getRecord()?.uin ?? '';
      const reserve = services.showEmojiCatalog.buildReserve(
        input.packId,
        input.variant ?? 0,
        selfUin,
      );
      const outcome = await services.messageSend.sendMedia({
        peerType: input.peerType,
        targetId: input.targetId,
        ...(input.tempGroupCode ? { tempGroupCode: input.tempGroupCode } : {}),
        kind: 'image',
        source,
        subType: 1,
        summary: '[动画表情]',
        showEmoji: reserve,
        ...(input.fileName ? { fileName: input.fileName } : {}),
      });
      recordRecentFromOutcome(services, outcome, input.fileName);
      return outcome;
    }),

  /** 清空「最近上传」。 */
  clearCustomEmojiRecent: procedure.mutation(() => {
    requireServices().customEmojiRecent.clear();
    return { ok: true };
  }),

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
