/**
 * `account.mediaResource.*` — browse the open account's local media caches:
 * 图片墙 (`nt_data/PhotoWall`) / QQ空间缓存 (`nt_data/Qzone`) as flat hash grids,
 * and 图片 (`nt_data/Pic`) / 视频 (`nt_data/Video`) as month-bucketed Ori+Thumb
 * listings. Thin tRPC skin over `MediaResourceService` (see `@weq/service`); all
 * scanning / merging lives there. Bytes are NOT returned here — the renderer
 * points `<img>`/`<video>` at `weq-media://localmedia`, resolved via the same
 * service. Read-only apart from `transcribeVoice`, which runs the recognition
 * engine on a cached clip (it writes nothing).
 */

import { z } from 'zod';
import { getAppContext, type AccountServices } from '../../context/app_context';
import type { TranscribeResult } from '../../transcribe/engine';
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
  listFlat: procedure.input(pageInput.extend({ kind: flatKind })).query(({ input }) => {
    return requireServices().mediaResource.listFlat(input.kind, {
      limit: input.limit,
      cursor: input.cursor ?? null,
    });
  }),

  /** One page of merged month entries (图片 / 视频, Ori + Thumb by hash). */
  listMonth: procedure.input(pageInput.extend({ kind: monthKind })).query(({ input }) => {
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

  /**
   * Resolve ONE message media element to its on-disk file.
   *
   * 收到的图片 / 语音 / 视频在 40800 里通常**不带** `localPath`(45004)，但 QQ 的
   * `nt_data` 缓存里其实有文件 —— 主进程按发送时间推月份、按文件名在 Ori/Thumb
   * 里找（与 `weq-media://pic` 同一条 FileSearchService 链路）。合并转发导入真实
   * 消息时用它补路径，否则媒体会被降级成 `[图片]` 文本。只读、不下载。
   */
  findLocalFile: procedure
    .input(
      z.object({
        /** 消息发送时间（毫秒）。 */
        t: z.number().int().nonnegative(),
        name: z.string().min(1),
        kind: z.enum(['pic', 'emoji', 'ptt', 'video', 'file']),
      }),
    )
    .query(async ({ input }) => {
      const { source, thumb } = await requireServices().fileSearch.findFile(
        input.t,
        input.name,
        input.kind,
      );
      return { source, thumb };
    }),

  /**
   * Transcribe one cached voice clip (语音 → 转文字). `rel` is the same Ptt-tree
   * path the browser streams through `weq-media://localvoice`; the service
   * re-validates it stays inside the tree. There's no message behind a cache
   * entry, so unlike `account.transcribeVoice` nothing is written back — the
   * text only lives in the browser's UI.
   *
   * Returns `{ success:false, error }` for every failure mode so the card can
   * show a friendly message instead of throwing.
   */
  transcribeVoice: procedure
    .input(z.object({ rel: z.string() }))
    .mutation(async ({ input }): Promise<TranscribeResult> => {
      const silk = await requireServices().mediaResource.resolveFile('ptt', input.rel);
      if (!silk) return { success: false, error: '语音文件不存在' };
      const r = await getAppContext().transcribeSilk(silk);
      return r.ok
        ? { success: true, text: r.text ?? '', emotion: r.emotion ?? null, events: r.events ?? [] }
        : { success: false, error: r.error };
    }),
});
