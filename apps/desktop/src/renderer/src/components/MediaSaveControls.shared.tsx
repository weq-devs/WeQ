import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaSaveSource } from '../../../shared/media_save';
import { client, trpc } from '../trpc/client';
import { mediaTransferTarget } from '../../../shared/transfer_progress';
import { useTransferActivity } from '../lib/transferActivity';
import { useExportSavePolicy } from '../hooks/useExportSavePolicy';
import { IS_WEB } from '../lib/target.shared';
import { useRenderDocument } from '../lib/renderDocument';
import { useToast } from './Toast.shared';
import { taskNotificationSource } from '../lib/notificationNavigation.shared';
import { notifyTaskCreated } from '../lib/taskNotifications';
import '../styles/media-save.css';

function sourceKey(source: MediaSaveSource): string {
  return JSON.stringify(source);
}
function normalizeSource(source: MediaSaveSource): MediaSaveSource {
  if (source.kind !== 'url' || !IS_WEB) return structuredClone(source);
  const url = new URL(source.url, window.location.href);
  return {
    ...source,
    url:
      url.origin === window.location.origin && /^\/_(?:media|asset)\//.test(url.pathname)
        ? `${url.pathname}${url.search}`
        : source.url,
  };
}
async function pause(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    signal.addEventListener('abort', finish, { once: true });
  });
}

type MediaSaveRecord = {
  taskId: string;
  status: 'running' | 'paused' | 'saved' | 'downloaded' | 'failed';
  error?: string;
};
type MediaSaveOwner = { released: boolean; tasks: Map<string, MediaSaveRecord> };

export function useMediaSave({
  waitForCompletion = false,
  foreground = false,
  ownerKey,
}: {
  waitForCompletion?: boolean;
  foreground?: boolean;
  ownerKey?: string;
} = {}) {
  const utils = trpc.useUtils();
  const transfers = useTransferActivity();
  const save = useExportSavePolicy(),
    document = useRenderDocument();
  const push = useToast((state) => state.push);
  const identity = `${save.binding?.expectedAccountUin}:${save.binding?.expectedAccountConfigId}`;
  const owner = useMemo<MediaSaveOwner>(
    () => ({ released: false, tasks: new Map() }),
    [identity, ownerKey],
  );
  const [results, setResults] = useState<{
    owner: MediaSaveOwner;
    rows: Map<string, MediaSaveRecord>;
  } | null>(null);
  const [operation, setOperation] = useState<{
    owner: MediaSaveOwner;
    key: string;
  } | null>(null);
  const pending = useRef<{
    identity: string;
    owner: MediaSaveOwner;
    key: string;
    controller: AbortController;
    taskId: string | null;
    expected: NonNullable<typeof save.binding>;
    cancelled: boolean;
  } | null>(null);
  const expectedUin = save.binding?.expectedAccountUin;
  const expectedConfig = save.binding?.expectedAccountConfigId;
  useEffect(() => {
    owner.released = false;
    return () => {
      owner.released = true;
      queueMicrotask(() => {
        if (!owner.released) return;
        if (pending.current?.owner === owner) pending.current.controller.abort();
        if (!foreground || !expectedUin || !expectedConfig) return;
        for (const task of owner.tasks.values()) {
          if (task.status === 'downloaded' || (task.status === 'saved' && !IS_WEB)) continue;
          void client.account.mediaSave.background
            .mutate({
              expectedAccountUin: expectedUin,
              expectedAccountConfigId: expectedConfig,
              taskId: task.taskId,
              unfinishedOnly: !IS_WEB,
            })
            .catch(() => undefined);
        }
      });
    };
  }, [owner, foreground, expectedUin, expectedConfig]);
  const busy = operation?.owner === owner;
  const waitingForSettings = !IS_WEB && save.settings.isLoading;
  const recordFor = (source: MediaSaveSource) =>
    results?.owner === owner ? results.rows.get(sourceKey(source)) : undefined;
  const record = (key: string, value: MediaSaveRecord | undefined) => {
    if (!foreground || owner.released) return;
    if (value) owner.tasks.set(key, value);
    else owner.tasks.delete(key);
    setResults({ owner, rows: new Map(owner.tasks) });
  };
  async function stopTask(op: NonNullable<typeof pending.current>) {
    if (!op.taskId) return false;
    try {
      return await client.account.mediaSave.cancel.mutate({ ...op.expected, taskId: op.taskId });
    } catch (error) {
      if (save.isCurrent())
        push({
          tone: 'error',
          title: '停止请求未确认，任务可能仍在后台',
          ...(foreground ? {} : { source: taskNotificationSource(op.taskId) }),
          detail: error instanceof Error ? error.message : String(error),
        });
      return false;
    }
  }
  async function cancel(source?: MediaSaveSource) {
    const op = pending.current;
    if (!op || op.owner !== owner) {
      const current = source && recordFor(source);
      if (source && current?.status === 'paused' && save.binding) {
        try {
          const stopped = await client.account.mediaSave.cancel.mutate({
            ...save.binding,
            taskId: current.taskId,
          });
          if (stopped) record(sourceKey(source), undefined);
        } catch (reason) {
          push({
            tone: 'error',
            title: '停止下载失败',
            detail: reason instanceof Error ? reason.message : String(reason),
          });
        }
      }
      return;
    }
    op.cancelled = true;
    op.controller.abort();
    if (await stopTask(op)) record(op.key, undefined);
  }
  async function run(
    source: MediaSaveSource,
    resumeId?: string,
  ): Promise<{ taskId: string | null; error?: string; cancelled?: boolean }> {
    if (!save.binding || pending.current?.identity === identity || waitingForSettings)
      return { taskId: null };
    const op = {
      identity,
      owner,
      key: sourceKey(source),
      controller: new AbortController(),
      taskId: null as string | null,
      expected: { ...save.binding },
      cancelled: false,
    };
    pending.current = op;
    setOperation({ owner, key: op.key });
    let target: string | undefined;
    const current = () =>
      pending.current === op &&
      !owner.released &&
      save.isCurrent() &&
      !op.controller.signal.aborted;
    try {
      const selected = normalizeSource(source);
      target = mediaTransferTarget(selected);
      transfers?.setLocal(target, { phase: 'preparing' });
      if (resumeId) {
        const resumed = await client.account.mediaSave.resume.mutate({
          ...op.expected,
          taskId: resumeId,
        });
        if (!resumed) throw new Error('暂时无法继续，请等下载收尾后再试');
        op.taskId = resumeId;
      } else {
        if (!current()) return { taskId: null, cancelled: true };
        op.taskId = await client.account.mediaSave.save.mutate({
          ...op.expected,
          source: selected,
          ...(IS_WEB ? { browserOutput: true } : { savePolicy: save.policy }),
          ...(foreground ? { foreground: true } : {}),
        });
      }
      if (op.cancelled && op.taskId && !(await stopTask(op))) {
        record(op.key, { taskId: op.taskId, status: 'running' });
      }
      if (foreground && op.taskId && owner.released && !op.cancelled) {
        await client.account.mediaSave.background.mutate({
          ...op.expected,
          taskId: op.taskId,
          unfinishedOnly: !IS_WEB,
        });
      }
      if (!op.taskId || !current()) return { taskId: op.taskId, cancelled: true };
      if (foreground) record(op.key, { taskId: op.taskId, status: 'running' });
      else notifyTaskCreated(op.taskId, IS_WEB ? '正在准备媒体下载' : '正在保存媒体');
      if (!IS_WEB && !waitForCompletion && !foreground) return { taskId: op.taskId };
      const deadline = Date.now() + 15 * 60_000;
      while (current() && Date.now() < deadline) {
        const receipt = await client.account.getExportOutputReceipt.query({
          ...op.expected,
          taskId: op.taskId,
        });
        if (!current()) break;
        if (!receipt) throw new Error('下载任务已被清理');
        if (receipt.status === 'failed') throw new Error(receipt.error || '媒体不可用');
        if (receipt.status === 'cancelled' || receipt.status === 'paused') {
          record(
            op.key,
            receipt.status === 'paused'
              ? { taskId: op.taskId, status: 'paused', error: receipt.error }
              : undefined,
          );
          return { taskId: op.taskId, cancelled: true };
        }
        if (receipt.status === 'completed') {
          if (!IS_WEB) {
            if (foreground && receipt.save?.status && receipt.save.status !== 'saved')
              throw new Error(receipt.save.error ?? '未能保存到所选位置');
            record(op.key, { taskId: op.taskId, status: 'saved' });
            if (foreground)
              void utils?.account?.mediaResource?.messageLocations
                ?.invalidate()
                .catch(() => undefined);
            return { taskId: op.taskId };
          }
          const result = await client.account.exportTaskDownload.mutate({
            ...op.expected,
            taskId: op.taskId,
          });
          if (!current()) break;
          if (!result) throw new Error('当前环境不支持浏览器下载');
          const link = document.createElement('a');
          link.href = result.url;
          link.download = '';
          document.body.append(link);
          link.click();
          link.remove();
          record(op.key, { taskId: op.taskId, status: 'downloaded' });
          return { taskId: op.taskId };
        }
        await pause(op.controller.signal);
      }
      if (current() && foreground) {
        await client.account.mediaSave.background.mutate({ ...op.expected, taskId: op.taskId });
        record(op.key, undefined);
      }
      if (current())
        push({
          tone: 'info',
          title: '文件仍在后台处理，结果将保留在任务列表',
          source: taskNotificationSource(op.taskId),
        });
      return { taskId: op.taskId, cancelled: !current() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (current()) {
        if (foreground && op.taskId)
          record(op.key, { taskId: op.taskId, status: 'failed', error: message });
        if (!foreground || !op.taskId)
          push({
            tone: 'error',
            title: '媒体保存失败',
            detail: message,
            ...(op.taskId ? { source: taskNotificationSource(op.taskId) } : {}),
          });
        return { taskId: op.taskId, error: message };
      }
      return { taskId: op.taskId, cancelled: true };
    } finally {
      if (target) transfers?.setLocal(target);
      if (pending.current === op) {
        pending.current = null;
        setOperation(null);
      }
    }
  }
  async function control(source: MediaSaveSource, action: 'resume' | 'open') {
    const item = recordFor(source);
    if (!item || !save.binding) return;
    const ref = { ...save.binding, taskId: item.taskId };
    try {
      if (action === 'resume') await run(source, item.taskId);
      else if (IS_WEB) {
        const result = await client.account.exportTaskDownload.mutate(ref);
        if (!result) throw new Error('当前环境不支持浏览器下载');
        if (owner.released || !save.isCurrent()) return;
        const link = document.createElement('a');
        link.href = result.url;
        link.download = '';
        document.body.append(link);
        link.click();
        link.remove();
        record(sourceKey(source), { ...item, status: 'downloaded' });
      } else await client.account.openSavedExportOutput.mutate(ref);
    } catch (reason) {
      push({
        tone: 'error',
        title: '媒体保存操作失败',
        detail: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }
  return {
    run,
    cancel,
    foreground,
    recordFor,
    control,
    busy,
    binding: save.binding,
    disabled: busy || !save.binding || waitingForSettings,
    isBusy: (source: MediaSaveSource) => busy && operation?.key === sourceKey(source),
    downloading: IS_WEB && busy,
  };
}
