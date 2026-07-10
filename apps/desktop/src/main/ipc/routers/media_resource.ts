/**
 * `account.mediaResource.*` — browse the open account's local media caches:
 * 图片墙 (`nt_data/PhotoWall`) / QQ空间缓存 (`nt_data/Qzone`) as flat hash grids,
 * and 图片 (`nt_data/Pic`) / 视频 (`nt_data/Video`) as month-bucketed Ori+Thumb
 * listings. Thin tRPC skin over `MediaResourceService` (see `@weq/service`); all
 * scanning / merging lives there. Bytes are NOT returned here — the renderer
 * points `<img>`/`<video>` at `weq-media://localmedia`, resolved via the same
 * service. Read-only.
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

const flatKind = z.enum(['photoWall', 'qzone']);
const monthKind = z.enum(['pic', 'video']);
const treeKey = z.enum(['avatar', 'emoji', 'pic', 'video', 'ptt', 'photoWall', 'qzone', 'file']);

const pageInput = z.object({
  limit: z.number().int().positive().optional(),
  cursor: z.string().nullish(),
});

export const mediaResourceRouter = router({
  /** One page of a flat hash cache (图片墙 / QQ空间缓存). */
  listFlat: procedure
    .input(pageInput.extend({ kind: flatKind }))
    .query(({ input }) => {
      return requireServices().mediaResource.listFlat(input.kind, {
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),

  /** One page of merged month entries (图片 / 视频, Ori + Thumb by hash). */
  listMonth: procedure
    .input(pageInput.extend({ kind: monthKind }))
    .query(({ input }) => {
      return requireServices().mediaResource.listMonth(input.kind, {
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),

  /** One page of voice clips (语音, Ptt cache — SILK, decoded on demand). */
  listVoice: procedure.input(pageInput).query(({ input }) => {
    return requireServices().mediaResource.listVoice({
      limit: input.limit,
      cursor: input.cursor ?? null,
    });
  }),

  /**
   * Aggregate stats for ONE resource tree (整体分析 scans them one at a time so
   * the slow, per-file `stat` walk can show progress). Returns count/bytes,
   * a by-month breakdown, and an original-vs-thumbnail split.
   */
  analyzeTree: procedure.input(z.object({ key: treeKey })).query(({ input }) => {
    return requireServices().mediaResource.analyzeTree(input.key);
  }),
});
