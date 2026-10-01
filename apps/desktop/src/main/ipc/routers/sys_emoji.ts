/**
 * `account.sysEmoji.*` — browse the open account's built-in system-emoji
 * resource set (`nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource/*`). Thin
 * tRPC skin over `SysEmojiResourceService` (see `@weq/service`). The image /
 * animation bytes are NOT returned here — the renderer streams each format via
 * the existing `weq-asset://emoji/<name>/<fmt>/<file>` protocol.
 *
 * `downloadStatus` / `downloadAll` cover the case where QQ's own resource
 * directory is missing: faces are then fetched from the official CDN into a
 * mirror cache (`SysEmojiDownloadService`). Rendering already backfills faces
 * one at a time on demand; this is the explicit "grab everything now" path.
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

export const sysEmojiRouter = router({
  /** One page of system-emoji faces (which of png/apng/lottie each carries). */
  listEntries: procedure
    .input(
      z.object({
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
      }),
    )
    .query(({ input }) => {
      return requireServices().sysEmoji.listEntries({
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),

  /**
   * 「可指定结果」的随机/互动动画表情：本地 `lottie/<faceId>_<n>.json` 有结果片段
   * 的表情，配上 emoji.db 的目录信息（desc / packId / stickerId / stickerType）。
   *
   * 前端据此渲染「随机表情」面板，选中结果后按 svc37 + QFaceExtra.resultId 发送。
   * 列表完全来自本机磁盘（QQ 下什么就有什么），不内置任何 faceId 白名单。
   */
  randomFaces: procedure.query(async () => {
    const services = requireServices();
    const [innerFaces, catalog] = await Promise.all([
      services.sysEmoji.listInnerFaces(),
      services.emoji.listSystemFaces(),
    ]);
    const byId = new Map(catalog.map((f) => [String(f.id), f]));
    const items = innerFaces
      .map((face) => {
        const entry = byId.get(String(face.faceId));
        // 没有贴纸目录信息（packId/stickerId）就发不了 svc37，直接丢掉 ——
        // 否则服务端会把 faceId 静默换一张脸（SnowLuma issue #168）。
        if (!entry?.sticker || !entry.packId || !entry.stickerId) return null;
        return {
          faceId: face.faceId,
          desc: entry.desc,
          packId: entry.packId,
          stickerId: entry.stickerId,
          stickerType: entry.stickerType,
          innerIds: face.innerIds,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { items };
  }),

  /** Whether QQ's own face directory exists, and how many faces are on disk. */
  downloadStatus: procedure.query(() => requireServices().sysEmojiDownload.status()),

  /** Fetch every downloadable face from the CDN into the mirror cache. */
  downloadAll: procedure.mutation(async () => {
    const services = requireServices();
    const result = await services.sysEmojiDownload.ensureAll();
    // The browser caches its directory listing; new faces won't show otherwise.
    services.sysEmoji.invalidate();
    return result;
  }),
});
