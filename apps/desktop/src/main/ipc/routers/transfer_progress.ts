import { observable } from '@trpc/server/observable';
import { z } from 'zod/v3';
import {
  flashFileTransferTarget,
  flashFilesetTransferTarget,
  type ActiveTransfer,
  type TransferProgress,
} from '../../../shared/transfer_progress';
import { accountEventBus, getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { requireResourceSource, resourceSourceInput } from './resource_source';

const activity = new WeakMap<
  object,
  {
    transfers: Map<string, ActiveTransfer>;
    resumeDownloads: Map<string, () => void>;
    listeners: Set<() => void>;
  }
>();

function accountTransfers(services: object) {
  let state = activity.get(services);
  if (!state) {
    state = { transfers: new Map(), resumeDownloads: new Map(), listeners: new Set() };
    activity.set(services, state);
  }
  return state;
}

function setTransfer(
  services: object,
  direction: ActiveTransfer['direction'],
  id: string,
  progress?: TransferProgress,
  target?: string,
) {
  const { transfers, listeners } = accountTransfers(services);
  if (progress) transfers.set(id, { ...progress, id, target, direction });
  else transfers.delete(id);
  for (const listener of listeners) listener();
}

export const transferIdInput = z.string().uuid().optional();

async function observeTransfer<T>(
  services: object,
  direction: ActiveTransfer['direction'],
  id: string | undefined,
  run: (update: (progress: TransferProgress) => void) => Promise<T>,
) {
  const update = (progress: TransferProgress) => {
    if (id) setTransfer(services, direction, id, progress);
  };
  try {
    update({ phase: 'preparing' });
    return await run(update);
  } finally {
    if (id) setTransfer(services, direction, id);
  }
}

export function observeUpload<T>(
  services: object,
  id: string | undefined,
  run: (update: (progress: TransferProgress) => void) => Promise<T>,
) {
  return observeTransfer(services, 'upload', id, run);
}

export function observeDownload<T>(
  services: object,
  id: string,
  run: (
    update: (progress: TransferProgress) => void,
    setResume: (resume?: () => void) => void,
  ) => Promise<T>,
) {
  const { resumeDownloads } = accountTransfers(services);
  return observeTransfer(services, 'download', id, async (update) => {
    try {
      return await run(update, (resume) => {
        if (resume) resumeDownloads.set(id, resume);
        else resumeDownloads.delete(id);
      });
    } finally {
      resumeDownloads.delete(id);
    }
  });
}

export function updateFlashUpload(
  services: AccountServices,
  fileset: string,
  phase: 'preparing' | 'upload' | 'confirming' | 'done' | 'failed',
  received?: number,
  total?: number,
  shortCode?: string,
) {
  for (const alias of [fileset, ...(shortCode ? [shortCode] : [])]) {
    const key = flashFilesetTransferTarget(alias, 'upload');
    setTransfer(
      services,
      'upload',
      key,
      phase === 'done' ? undefined : { phase, received, total },
      key,
    );
    if (phase === 'failed') {
      // 错误保留一段可见时间供重开会话核对，不落库、不生成任务。
      setTimeout(() => setTransfer(services, 'upload', key), 5 * 60_000).unref();
    }
  }
}

function snapshot(services: AccountServices): ActiveTransfer[] {
  const downloads: ActiveTransfer[] = [];
  for (const task of services.exportManager.activeResourceTransfers()) {
    const phase =
      task.status === 'pending' || (!task.received && !task.total && !task.files.length)
        ? 'preparing'
        : task.total && task.received === task.total
          ? 'confirming'
          : 'download';
    const batch: ActiveTransfer = {
      direction: 'download',
      id: task.id,
      phase,
      received: task.received,
      total: task.total,
      processed: task.processed,
      items: task.items,
    };
    downloads.push({ ...batch, target: task.targets?.[0] });
    for (const target of task.targets?.slice(1) ?? [])
      downloads.push({ ...batch, id: `${task.id}:${target}`, target });
    for (const { target, received, total } of task.files)
      downloads.push({
        direction: 'download',
        id: `${task.id}:${target}`,
        target,
        phase: total && received === total ? 'confirming' : 'download',
        received,
        total,
      });
  }
  for (const batch of services.flashTransferFiles.downloads.activeDownloadBatches()) {
    const phase = batch.status === 'downloading' ? 'download' : 'preparing';
    downloads.push({
      direction: 'download',
      id: batch.id,
      target: flashFilesetTransferTarget(batch.filesetId, 'download'),
      phase,
      received: batch.downloadedBytes,
      total: batch.files.every(
        (file) => file.fileSize > 0 && file.status !== 'failed' && file.status !== 'cancelled',
      )
        ? batch.fileSize
        : undefined,
      processed: batch.files.filter((file) => ['done', 'failed', 'cancelled'].includes(file.status))
        .length,
      items: batch.files.length,
    });
    for (const file of batch.files) {
      if (!['downloading', 'resolving', 'pending'].includes(file.status)) continue;
      downloads.push({
        direction: 'download',
        id: file.id,
        target: flashFileTransferTarget(file.filesetId, file.physicalId),
        phase: file.status === 'downloading' ? 'download' : 'preparing',
        received: file.downloadedBytes,
        total: file.fileSize || undefined,
      });
    }
  }
  return [...accountTransfers(services).transfers.values(), ...downloads];
}

export const transferProgressRouter = router({
  continuePreviewDownload: procedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) => {
      const services = getAppContext().services;
      const resume = services && accountTransfers(services).resumeDownloads.get(input.id);
      if (!resume) return false;
      resume();
      return true;
    }),
  watch: procedure.input(resourceSourceInput.required()).subscription(({ input }) => {
    const services = requireResourceSource(input);
    return observable<ActiveTransfer[]>((emit) => {
      const state = accountTransfers(services);
      const flash = services.flashTransferFiles.downloads;
      const manager = services.exportManager;
      let pending: ReturnType<typeof setTimeout> | undefined;
      let lastSent = -Infinity;
      const publish = () => {
        pending = undefined;
        lastSent = performance.now();
        if (
          getAppContext().services === services &&
          services.accountConfig.getRecord()?.configId === input.expectedAccountConfigId
        )
          emit.next(snapshot(services));
        else emit.complete();
      };
      const schedule = () => {
        pending ??= setTimeout(publish, Math.max(0, 120 - (performance.now() - lastSent)));
      };
      const unsubscribe = manager.subscribeResourceTransfers(schedule);
      state.listeners.add(schedule);
      manager.on('progress', schedule);
      flash.on('task', schedule);
      const close = () => emit.complete();
      accountEventBus.on('closing', close);
      publish();
      return () => {
        clearTimeout(pending);
        unsubscribe();
        state.listeners.delete(schedule);
        manager.off('progress', schedule);
        flash.off('task', schedule);
        accountEventBus.off('closing', close);
      };
    });
  }),
});
