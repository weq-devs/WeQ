/**
 * `account.mediaResource.*` — browse the open account's local media caches:
 * 图片墙 (`nt_data/PhotoWall`) / QQ空间缓存 (`nt_data/Qzone`) as flat hash grids,
 * and 图片 (`nt_data/Pic`) / 视频 (`nt_data/Video`) as month-bucketed Ori+Thumb
 * listings. Thin tRPC skin over `MediaResourceService` (see `@weq/service`); all
 * scanning / merging lives there. Bytes are NOT returned here — the renderer
 * points `<img>`/`<video>` at `weq-media://localmedia`, resolved via the same
 * service. Opening a chat download can also acknowledge its task result.
 */
import { getHost, getLogger, OperationError } from '@weq/service';

import { z } from 'zod/v3';
import { getAppContext, requirePlatform, type AccountServices } from '../../context/app_context';
import type { TranscribeResult } from '../../transcribe/engine';
import { procedure, router } from '../trpc';
import { messageMediaLocations } from '../../message_media_local';
import { messageMediaLocationMissing } from '../../../shared/message_media';
import { forwardCacheKindInput } from '../../../shared/forward_cache';
import { exportTaskResult } from '../../../shared/export_task_result';
import { exportArchivePolicy } from '../../../shared/task_archive';
import { archiveViewedTask, taskArchiveStore } from '../../task_archive';
import { boundClientState } from './client_state';
import {
  resourceSourceInput,
  requireResourceSource,
  assertResourceSource,
} from './resource_source';

const logger = getLogger().child({ scope: 'media-resource' });

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

const flatKind = z.enum(['photoWall', 'qzone']);
const monthKind = z.enum(['pic', 'video']);
const treeKey = z.enum(['avatar', 'emoji', 'pic', 'video', 'ptt', 'photoWall', 'qzone', 'file']);

const pageInput = z.object({
  limit: z.number().int().positive().optional(),
  cursor: z.string().nullish(),
  requestId: z.string().uuid().optional(),
});

const pages = new WeakMap<
  AccountServices,
  {
    active: Map<string, AbortController>;
    retired: Map<string, number>;
  }
>();
function accountPages(services: AccountServices) {
  let state = pages.get(services);
  if (!state) {
    state = { active: new Map(), retired: new Map() };
    pages.set(services, state);
  }
  return state;
}

async function mediaPage<T>(
  requestId: string | undefined,
  read: (services: AccountServices, signal?: AbortSignal) => Promise<T>,
) {
  const services = requireServices();
  const source = {
    expectedAccountUin: String(getAppContext().account?.context.uin ?? ''),
    expectedAccountConfigId: services.accountConfig.getRecord()?.configId,
  };
  if (!requestId) {
    const result = await read(services);
    assertResourceSource(services, source);
    return result;
  }
  const { active, retired } = accountPages(services);
  const cancelledUntil = retired.get(requestId) ?? 0;
  retired.delete(requestId);
  if (cancelledUntil > Date.now()) throw new DOMException('已取消资源分页', 'AbortError');
  if (active.has(requestId)) throw new Error('资源分页请求已开始');
  const controller = new AbortController();
  active.set(requestId, controller);
  try {
    const result = await read(services, controller.signal);
    controller.signal.throwIfAborted();
    assertResourceSource(services, source);
    return result;
  } finally {
    active.delete(requestId);
  }
}

const messageMediaInput = resourceSourceInput.extend({
  target: z.object({
    kind: z.enum(['pic', 'emoji', 'video', 'ptt', 'file', 'mface']),
    t: z.number().nonnegative(),
    name: z.string(),
    token: z.string(),
    md5: z.string(),
    msgId: z.string(),
    conv: z.string(),
    fwdMsgId: z.string().optional(),
    fwdKind: forwardCacheKindInput.optional(),
    fwdResId: z.string().max(4096).optional(),
    pack: z.string(),
    hash: z.string(),
    label: z.string(),
    url: z.string().optional(),
  }),
});
const locationInput = z.object({
  kind: z.enum(['saved', 'local', 'cache', 'thumbnail', 'cover', 'transcoded']),
  key: z.string().min(1),
});

export const mediaResourceRouter = router({
  messageLocations: procedure
    .input(messageMediaInput.extend({ exactFile: z.boolean().optional() }))
    .query(async ({ input }) => {
      const services = requireResourceSource(input);
      const locations = await messageMediaLocations(services, input.target, input.exactFile);
      assertResourceSource(services, input);
      return locations.map(({ kind, key, available }) => ({ kind, key, available }));
    }),
  openMessageFile: procedure
    .input(messageMediaInput.extend({ location: locationInput.optional() }))
    .mutation(async ({ input }) => {
      const host = getHost();
      if (!host.canReveal || host.remoteClient) throw new Error('当前环境不支持打开本机文件');
      if (input.target.kind !== 'file') throw new Error('不是文件消息');
      const services = requireResourceSource(input);
      const locations = await messageMediaLocations(services, input.target, true);
      assertResourceSource(services, input);
      const { location } = input;
      const selected = location
        ? locations.find(({ kind, key }) => kind === location.kind && key === location.key)
        : (locations.find((item) => item.kind === 'local' && item.available) ??
          locations.find((item) => item.available));
      if (!selected?.available) {
        if (location) throw new Error('本地文件已移动或删除，请重新保存');
        return false;
      }
      await host.revealPath(selected.path);
      const context = getAppContext();
      const { download } = selected;
      if (!download || context.services !== services) return true;
      const task = services.exportManager.getTask(download.taskId);
      const expectedAccountUin = context.account?.context.uin;
      const expectedAccountConfigId = services.accountConfig.getRecord()?.configId;
      if (!task || !expectedAccountUin || !expectedAccountConfigId) return true;
      const { id, result } = exportTaskResult(task);
      if (
        result !== download.result ||
        (task.save?.path !== selected.path && task.filePath !== selected.path)
      )
        return true;
      try {
        const state = boundClientState({ expectedAccountUin, expectedAccountConfigId });
        if (state.snapshot().records.tasks?.[id] !== result)
          state.records('tasks', { [id]: result });
        if (exportArchivePolicy(task).auto)
          archiveViewedTask(
            taskArchiveStore(requirePlatform().appDataRoot(), expectedAccountConfigId),
            id,
            result,
          );
      } catch (error) {
        logger.warn('文件已打开，下载任务已读状态保存失败', { error });
      }
      return true;
    }),
  revealMessageMedia: procedure
    .input(messageMediaInput.extend({ location: locationInput }))
    .mutation(async ({ input }) => {
      const host = getHost();
      if (!host.canReveal) throw new Error('当前环境不支持在文件夹中显示');
      const services = requireResourceSource(input);
      const locations = await messageMediaLocations(services, input.target);
      assertResourceSource(services, input);
      const selected = locations.find(
        ({ kind, key }) => kind === input.location.kind && key === input.location.key,
      );
      if (!selected && locations.some(({ kind }) => kind === input.location.kind))
        throw new Error('文件定位位置已更新，请重新打开菜单后再试');
      if (!selected?.available) throw new Error(messageMediaLocationMissing(input.location.kind));
      await host.revealInFolder(selected.path);
      return true;
    }),
  /** One page of a flat hash cache (图片墙 / QQ空间缓存). */
  listFlat: procedure.input(pageInput.extend({ kind: flatKind })).query(({ input }) => {
    return mediaPage(input.requestId, ({ mediaResource }, signal) =>
      mediaResource.listFlat(input.kind, {
        limit: input.limit,
        cursor: input.cursor ?? null,
        signal,
      }),
    );
  }),

  /** One page of merged month entries (图片 / 视频, Ori + Thumb by hash). */
  listMonth: procedure
    .input(pageInput.extend({ kind: monthKind, observedIndex: z.boolean().optional() }))
    .query(({ input }) => {
      return mediaPage(input.requestId, ({ mediaResource }, signal) =>
        mediaResource.listMonth(input.kind, {
          limit: input.limit,
          cursor: input.cursor ?? null,
          signal,
          observedIndex: input.observedIndex,
        }),
      );
    }),

  /** One page of voice clips (语音, Ptt cache — SILK, decoded on demand). */
  listVoice: procedure
    .input(pageInput.extend({ observedIndex: z.boolean().optional() }))
    .query(({ input }) => {
      return mediaPage(input.requestId, ({ mediaResource }, signal) =>
        mediaResource.listVoice({
          limit: input.limit,
          cursor: input.cursor ?? null,
          signal,
          observedIndex: input.observedIndex,
        }),
      );
    }),

  cancelPage: procedure.input(z.object({ requestId: z.string().uuid() })).mutation(({ input }) => {
    const services = getAppContext().services;
    if (!services) return;
    const { active, retired } = accountPages(services);
    const controller = active.get(input.requestId);
    if (controller) controller.abort();
    else {
      // Web 的读与取消可走两个连接，记录短期取消以处理反序送达。
      const now = Date.now();
      for (const [id, expires] of retired) if (expires <= now) retired.delete(id);
      retired.set(input.requestId, now + 15_000);
      while (retired.size > 128) retired.delete(retired.keys().next().value!);
    }
  }),

  /**
   * Aggregate stats for ONE resource tree (整体分析 scans them one at a time so
   * the slow, per-file `stat` walk can show progress). Returns count/bytes,
   * a by-month breakdown, and an original-vs-thumbnail split.
   */
  analyzeTree: procedure
    .input(resourceSourceInput.extend({ key: treeKey }))
    .query(async ({ input }) => {
      const services = requireResourceSource(input);
      const stat = await services.mediaResource.analyzeTree(input.key);
      assertResourceSource(services, input);
      return stat;
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
