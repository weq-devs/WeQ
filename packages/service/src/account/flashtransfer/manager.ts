import { networkFetch } from '@weq/network';
/**
 * 闪传下载任务管理器 —— 落盘持久化 + 并发下载 + 逐文件进度事件。
 *
 * 任务列表保存在 `cacheDir/flash/tasks.json`（跟随设置的缓存路径），应用
 * 重启后仍能看到历史任务和状态。下载用并发池（默认 4），每个文件先换直链
 * 再流式落盘，保留原始目录结构。
 *
 * 事件：
 *   - 'task'    ：某个任务状态/进度变化，载荷为更新后的 FlashDownloadTask
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, mkdir, lstat, readdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { ManagedDownload, TransferDeferredError } from '../../common/managed_download';
import { networkScope, transferBehavior } from '../../common/network_scope';
import { shouldPauseTransfer } from '../../common/data_saver';
import {
  transferCanResume,
  transferOwner,
  transferRestricted,
  watchTransferPolicy,
} from '../../common/transfer_policy';
import { getLogger, logErrorContext } from '../../common/logger';
import { safeRelSegments, sanitizeSegment, uniqueName } from '../../common/path_sanitize';
import { writeFileAtomic } from '../../common/atomic_write';
import { FlashTransferClient } from './client';
import { FlashTransferResolver } from './resolver';
import { groupFlashDownloads } from './batches';
import type {
  FlashDownloadBatch,
  FlashDownloadTask,
  FlashSelection,
  FlashTaskStatus,
} from './types';

const logger = getLogger().child({ scope: 'flash-transfer-download' });

const DONE_FLASH_STATUSES: ReadonlySet<FlashTaskStatus> = new Set(['done']);
/** 整次操作只有在没有待处理文件时才会被归并为这些状态。 */
const FINISHED_FLASH_STATUSES: ReadonlySet<FlashTaskStatus> = new Set([
  'done',
  'failed',
  'cancelled',
]);

const CONCURRENCY = 4;
/** 同名文件在同一目录下的去重后缀（保留原始目录结构的前提）。 */
const MAX_NAME_LEN = 120;

const fetchFlashFile: typeof fetch = async (url, options) => {
  const response = await networkFetch(url, options);
  const type = response.headers.get('content-type') ?? '';
  if (response.ok && (type.startsWith('text/') || type.includes('json'))) {
    await response.body?.cancel();
    throw new Error('闪传返回的内容不是文件');
  }
  return response;
};

export class FlashTransferDownloadManager extends EventEmitter {
  private readonly tasksPath: string;
  private tasks: FlashDownloadTask[] = [];
  private readonly aborts = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private readonly publishing = new Set<string>();
  private readonly cleaning = new Set<string>();
  private readonly transfers = new Map<string, ManagedDownload>();
  private readonly requests = new Map<
    string,
    { owner?: string; batch: boolean; override: boolean }
  >();
  private unwatchQueue?: () => void;
  private pumping = false;
  private loading: Promise<void> | undefined;
  private writes = Promise.resolve();
  private readonly client: FlashTransferClient;
  private readonly resolver: FlashTransferResolver;
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly baseDir: string,
    client?: FlashTransferClient,
  ) {
    super();
    this.tasksPath = join(baseDir, 'tasks.json');
    this.client = client ?? new FlashTransferClient();
    this.resolver = new FlashTransferResolver(this.client);
    void this.load().catch((error) => {
      logger.error('failed to load flash tasks', {
        event: 'flash-tasks-load',
        ...logErrorContext(error),
      });
    });
  }

  /** 下载根目录（前端“打开目录”用）。 */
  get rootDir(): string {
    return this.baseDir;
  }

  load(): Promise<void> {
    this.loading ??= this.readTasks();
    return this.loading;
  }

  private async readTasks(): Promise<void> {
    try {
      const raw = await readFile(this.tasksPath, 'utf8');
      const parsed = JSON.parse(raw) as FlashDownloadTask[];
      if (Array.isArray(parsed)) {
        const now = Date.now();
        this.tasks = parsed.map((task) =>
          task.status === 'pending' || task.status === 'resolving' || task.status === 'downloading'
            ? {
                ...task,
                status: 'failed',
                interrupted: true,
                pausedByPolicy: undefined,
                finishedAt: now,
                downloadedBytes: 0,
                error: '上次下载已中断，可重试未完成文件。',
              }
            : task,
        );
      }
    } catch {
      // 首次运行 / 文件损坏：从空列表开始。
    }
  }

  private async persist(strict = false): Promise<void> {
    try {
      const data = JSON.stringify(this.tasks, null, 2);
      const write = this.writes.catch(() => {}).then(() => writeFileAtomic(this.tasksPath, data));
      this.writes = write;
      await write;
    } catch (error) {
      logger.error('failed to persist flash tasks', {
        event: 'flash-tasks-write',
        ...logErrorContext(error),
      });
      if (strict) throw error;
    }
  }

  private recordTaskLog(task: FlashDownloadTask): void {
    const previous = task.logs?.at(-1);
    const stage = task.status;
    const pct = task.fileSize > 0 ? Math.floor((task.downloadedBytes / task.fileSize) * 10) : 0;
    const checkpoint = `${stage}:${pct}`;
    if (
      !previous ||
      previous.stage.split(':')[0] !== stage ||
      (stage === 'downloading' && previous.stage !== checkpoint && Date.now() - previous.ts >= 1000)
    ) {
      const label = {
        pending: '等待下载',
        resolving: '获取下载链接',
        downloading: '下载中',
        done: '文件已保存',
        failed: '下载失败',
        cancelled: '已取消下载',
      }[stage];
      task.logs = [
        ...(task.logs ?? []).slice(-99),
        {
          ts: Date.now(),
          seq: (previous?.seq ?? 0) + 1,
          stage: checkpoint,
          level: stage === 'failed' ? 'error' : stage === 'cancelled' ? 'warn' : 'info',
          text: `${task.relativePath} · ${label}${stage === 'downloading' && task.fileSize > 0 ? ` · ${Math.min(100, pct * 10)}%` : ''}${task.error ? ` · ${task.error}` : ''}`.slice(
            0,
            4000,
          ),
        },
      ];
    }
  }

  private emitTask(task: FlashDownloadTask): void {
    this.recordTaskLog(task);
    this.emit('task', task);
  }

  /** 按下载操作归并，文件明细保留在 files 中，新的在前。 */
  list(filter?: (task: FlashDownloadTask) => boolean, withLogs = true): FlashDownloadBatch[] {
    const tasks = filter ? this.tasks.filter(filter) : this.tasks;
    return groupFlashDownloads(
      withLogs ? tasks : tasks.map((task) => ({ ...task, logs: undefined })),
    )
      .map((task) => ({
        ...task,
        canRetry:
          task.pausedByPolicy ||
          (task.files.some((file) => file.status === 'failed' || file.status === 'cancelled') &&
            task.files.every(
              (file) =>
                FINISHED_FLASH_STATUSES.has(file.status) &&
                !this.running.has(file.id) &&
                !this.cleaning.has(file.id),
            )),
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  activeDownloadBatches(): FlashDownloadBatch[] {
    const active = new Set(
      this.tasks
        .filter((task) => !FINISHED_FLASH_STATUSES.has(task.status))
        .map((task) => task.batchId ?? task.id),
    );
    // 快照仅取在途批次，避免一个分块更新去重组全部历史日志。
    return groupFlashDownloads(
      this.tasks
        .filter((task) => active.has(task.batchId ?? task.id))
        .map((task) => ({ ...task, logs: undefined })),
    );
  }

  /** 只重试失败或取消的文件；旧下载完全退出后才复用任务身份与路径。 */
  retry(taskId: string, { background = false }: { background?: boolean } = {}): Promise<boolean> {
    const owner = transferOwner();
    const request = this.startQueue.then(async () => {
      await this.loading;
      const batch = this.list().find((task) => task.id === taskId);
      if (!batch?.canRetry) return false;
      if (batch.pausedByPolicy) {
        const previous = this.requests.get(taskId);
        this.requests.set(taskId, {
          ...previous,
          batch: previous?.batch ?? batch.files.length > 1,
          override: true,
        });
        for (const file of batch.files) this.transfers.get(file.id)?.continue();
        this.pump();
        return true;
      }
      const files = batch.files.filter(
        (file) => file.status === 'failed' || file.status === 'cancelled',
      );
      const previous = (background ? batch.files : files).map(
        (file) => [file, { ...file }] as const,
      );
      if (background) for (const file of batch.files) delete file.foreground;
      for (const file of files) {
        file.status = 'pending';
        delete file.interrupted;
        delete file.pausedByUser;
        file.error = undefined;
        file.finishedAt = undefined;
        file.downloadedBytes = 0;
      }
      try {
        await this.persist(true);
      } catch (error) {
        for (const [file, snapshot] of previous) Object.assign(file, snapshot);
        throw error;
      }
      this.requests.set(taskId, {
        owner,
        batch: files.length > 1,
        override: batch.pausedByUser === true,
      });
      for (const file of files) this.emitTask(file);
      this.pump();
      return true;
    });
    this.startQueue = request.catch(() => {});
    return request;
  }

  /**
   * 解析选择 → 记录操作归属 → 后台并发下载。返回文件数、操作 id 和解析期错误。
   * 目录递归在调用内完成，一次操作只在常规任务列表占一项。
   */
  start(
    filesetName: string,
    filesetId: string,
    selections: FlashSelection[],
    directory: string,
    viewFilesetId?: string,
    browserOutput = false,
  ): Promise<{ started: number; errors: string[]; taskId?: string }> {
    const owner = transferOwner();
    const request = this.startQueue.then(() =>
      this.enqueue(
        filesetName,
        filesetId,
        selections,
        directory,
        viewFilesetId,
        browserOutput,
        owner,
      ),
    );
    this.startQueue = request.catch(() => {});
    return request;
  }

  background(taskId: string, viewFilesetId: string): Promise<boolean> {
    const request = this.startQueue.then(async () => {
      await this.loading;
      const batch = this.tasks.filter(
        (file) => file.batchId === taskId && file.viewFilesetId === viewFilesetId,
      );
      if (!batch.length) return false;
      const foreground = batch.filter((file) => file.foreground);
      if (!foreground.length) return true;
      for (const file of foreground) file.foreground = false;
      try {
        await this.persist(true);
      } catch (error) {
        for (const file of foreground) file.foreground = true;
        throw error;
      }
      return true;
    });
    this.startQueue = request.catch(() => {});
    return request;
  }

  private async enqueue(
    filesetName: string,
    filesetId: string,
    selections: FlashSelection[],
    directory: string,
    viewFilesetId: string | undefined,
    browserOutput: boolean,
    owner?: string,
  ) {
    await this.loading;
    if (!isAbsolute(directory) || !(await lstat(directory)).isDirectory())
      throw new Error('保存目录不可用，请重新选择');
    const { files, errors } = await this.resolver.resolveDownloads(selections);
    const batchId = randomUUID();
    const now = Date.now();
    const usedByDir = new Map<string, Set<string>>();

    const newTasks: FlashDownloadTask[] = [];
    for (const f of files) {
      const segments = safeRelSegments(f.relativePath, { maxLen: MAX_NAME_LEN });
      const dir = join(
        resolve(directory),
        sanitizeSegment(filesetName || filesetId, 'flash', { maxLen: MAX_NAME_LEN }),
        ...segments.slice(0, -1),
      );
      let used = usedByDir.get(dir);
      if (!used) {
        used = new Set(
          (
            await readdir(dir).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return [];
              throw error;
            })
          ).map((name) => name.toLowerCase()),
        );
        for (const task of this.tasks)
          if (dirname(task.targetPath) === dir)
            used.add(task.targetPath.slice(dir.length + 1).toLowerCase());
      }
      usedByDir.set(dir, used);
      const fileName = uniqueName(segments.at(-1) ?? 'file', used);
      newTasks.push({
        id: randomUUID(),
        batchId,
        ...(viewFilesetId ? { viewFilesetId, foreground: true } : {}),
        ...(browserOutput ? { browserOutput: true } : {}),
        filesetId: f.filesetId || filesetId,
        filesetName: filesetName || '闪传下载',
        name: f.name,
        physicalId: f.physicalId,
        relativePath: f.relativePath,
        targetPath: join(dir, fileName),
        fileSize: f.fileSize,
        status: 'pending',
        downloadedBytes: 0,
        createdAt: now,
      });
    }
    if (newTasks[0] && errors.length) newTasks[0].resolutionErrors = errors;

    this.tasks.push(...newTasks);
    try {
      await this.persist(true);
    } catch (error) {
      const ids = new Set(newTasks.map((task) => task.id));
      this.tasks = this.tasks.filter((task) => !ids.has(task.id));
      throw error;
    }
    if (newTasks.length) {
      this.requests.set(batchId, { owner, batch: newTasks.length > 1, override: false });
      for (const task of newTasks) this.emitTask(task);
      this.pump();
    }
    return { started: newTasks.length, errors, taskId: newTasks.length ? batchId : undefined };
  }

  /** 暂停整次下载操作，已完成的文件保留。 */
  async pause(taskId: string, foregroundOnly = false): Promise<boolean> {
    await this.loading;
    const files = this.tasks.filter(
      (task) =>
        (task.batchId ?? task.id) === taskId &&
        (!foregroundOnly || task.foreground) &&
        !this.publishing.has(task.id) &&
        ['pending', 'resolving', 'downloading'].includes(task.status),
    );
    if (!files.length) return false;
    for (const task of files) {
      task.status = 'failed';
      task.interrupted = true;
      task.pausedByUser = true;
      delete task.pausedByPolicy;
      task.downloadedBytes = 0;
      task.finishedAt = Date.now();
      task.error = '已手动暂停；继续时只重试未完成文件。';
      this.aborts.get(task.id)?.abort();
      this.emitTask(task);
    }
    await Promise.all(
      files.filter((task) => !this.running.has(task.id)).map((task) => this.removePartial(task)),
    );
    await this.persist(true);
    this.pump();
    return true;
  }

  async cancel(taskId: string): Promise<boolean> {
    await this.loading;
    const tasks = this.tasks.filter((t) => (t.batchId ?? t.id) === taskId);
    if (!tasks.length) return false;
    for (const task of tasks) {
      if (this.publishing.has(task.id)) continue;
      if (
        !task.interrupted &&
        task.status !== 'pending' &&
        task.status !== 'resolving' &&
        task.status !== 'downloading'
      )
        continue;
      this.aborts.get(task.id)?.abort();
      task.status = 'cancelled';
      delete task.pausedByPolicy;
      if (task.interrupted) {
        delete task.interrupted;
        delete task.pausedByUser;
        delete task.error;
      }
      task.finishedAt = Date.now();
      this.emitTask(task);
    }
    await Promise.all(
      tasks
        .filter((task) => task.status === 'cancelled' && !this.running.has(task.id))
        .map((task) => this.removePartial(task)),
    );
    await this.persist();
    return true;
  }

  /** 清掉已结束（完成/失败/取消）的任务；进行中的保留。 */
  async clearFinished(): Promise<number> {
    return this.removeFinished(null, FINISHED_FLASH_STATUSES, false);
  }

  /** 统一任务入口仅清除确认时选中的已结束记录，不删除下载文件。 */
  async clearFinishedSelection(taskIds: string[]): Promise<number> {
    return this.removeFinished(new Set(taskIds), FINISHED_FLASH_STATUSES, true);
  }

  /** 统一任务入口仅清除已确认的成功记录，不删除下载文件。 */
  async clearCompleted(taskIds: string[]): Promise<number> {
    return this.removeFinished(new Set(taskIds), DONE_FLASH_STATUSES, true);
  }

  /**
   * 按整次下载操作移除记录：只认选中的 ID 与该次确认时的状态，之后完成或
   * 仍在进行的操作不会被顺手清掉。`ids` 为 null 时清全部匹配状态。
   */
  private async removeFinished(
    ids: Set<string> | null,
    statuses: ReadonlySet<FlashTaskStatus>,
    strict: boolean,
  ): Promise<number> {
    await this.loading;
    const matched = new Set(
      this.list()
        .filter(
          (task) => (!ids || ids.has(task.id)) && !task.interrupted && statuses.has(task.status),
        )
        .map((task) => task.id),
    );
    if (!matched.size) return 0;
    const removed = this.tasks.filter((task) => matched.has(task.batchId ?? task.id));
    if (!removed.length) return 0;
    const removedIds = new Set(removed.map((task) => task.id));
    this.tasks = this.tasks.filter((task) => !removedIds.has(task.id));
    try {
      await this.persist(strict);
    } catch (error) {
      this.tasks.push(...removed);
      throw error;
    }
    return matched.size;
  }

  // ---- 后台调度 ----------------------------------------------------------

  private partialPath(task: FlashDownloadTask) {
    return `${task.targetPath}.weq-part-${task.id}`;
  }

  private async removePartial(task: FlashDownloadTask) {
    this.cleaning.add(task.id);
    const path = this.partialPath(task);
    try {
      await Promise.all(
        [`${path}.part`, `${path}.resume.json`].map((file) =>
          rm(file, { force: true }).catch((error: unknown) =>
            logger.warn('清理闪传临时文件失败', { error: String(error) }),
          ),
        ),
      );
    } finally {
      this.cleaning.delete(task.id);
    }
  }

  private updateQueuedPolicy(task: FlashDownloadTask) {
    const request = this.requests.get(task.batchId ?? task.id);
    const behavior = transferBehavior();
    const restricted =
      transferRestricted(request?.owner) ||
      (task.pausedByPolicy && !transferCanResume(request?.owner));
    const paused =
      !request?.override &&
      (shouldPauseTransfer(
        Boolean(restricted),
        request?.batch ?? false,
        task.fileSize,
        task.downloadedBytes,
        behavior,
      ) ||
        (task.pausedByPolicy && !behavior.dataSaverAutoResume));
    if (Boolean(task.pausedByPolicy) !== Boolean(paused)) {
      task.pausedByPolicy = paused || undefined;
      this.emitTask(task);
    }
    return paused;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const live = new Set<string>();
      let queued = false;
      for (const task of this.tasks) {
        const batchId = task.batchId ?? task.id;
        if (this.running.has(task.id)) live.add(batchId);
        else if (task.status === 'pending' && this.requests.has(batchId)) {
          live.add(batchId);
          if (this.updateQueuedPolicy(task) || this.running.size >= CONCURRENCY) {
            queued = true;
            continue;
          }
          this.running.add(task.id);
          void this.runTask(task).finally(() => {
            this.running.delete(task.id);
            this.pump();
          });
        }
      }
      for (const id of this.requests.keys()) if (!live.has(id)) this.requests.delete(id);
      if (queued) this.unwatchQueue ??= watchTransferPolicy(() => this.pump());
      else {
        this.unwatchQueue?.();
        this.unwatchQueue = undefined;
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runTask(task: FlashDownloadTask): Promise<void> {
    const abort = new AbortController();
    const partialPath = this.partialPath(task);
    this.aborts.set(task.id, abort);
    let finished = false;
    try {
      // 取消竞态：cancel() 可能在 pump 调度后才生效，这里每次推进前复查。
      if (abort.signal.aborted || (task.status as FlashTaskStatus) === 'cancelled') return;

      // 1) 换直链
      task.status = 'resolving';
      task.error = undefined;
      this.emitTask(task);
      const url = await this.client.getDownloadUrl(task.physicalId);
      if (abort.signal.aborted || (task.status as FlashTaskStatus) === 'cancelled') return;

      const request = this.requests.get(task.batchId ?? task.id);
      const transfer = networkScope.run(
        {
          restricted: false,
          intent: 'batch',
          clientId: request?.owner,
          override: request?.override,
        },
        () =>
          new ManagedDownload({
            batch: request?.batch,
            total: task.fileSize,
            signal: abort.signal,
            deferOnPolicyPause: true,
            fetcher: fetchFlashFile,
            maxAttempts: 4,
            attemptsPerSource: 4,
            retryBaseMs: 300,
            state: ({ paused, total, received }) => {
              if (abort.signal.aborted) return;
              if (total > 0) task.fileSize = total;
              if (paused) task.downloadedBytes = received;
              if (Boolean(task.pausedByPolicy) === paused) return;
              task.pausedByPolicy = paused || undefined;
              this.emitTask(task);
            },
            publish: async (part) => {
              this.publishing.add(task.id);
              await copyFile(part, task.targetPath, constants.COPYFILE_EXCL);
            },
          }),
      );
      this.transfers.set(task.id, transfer);
      task.status = 'downloading';
      this.emitTask(task);
      await mkdir(dirname(partialPath), { recursive: true });
      await transfer.file([url], partialPath, {}, (received) => {
        task.downloadedBytes = received;
        this.emitTask(task);
      });
      if (abort.signal.aborted) return;

      task.status = 'done';
      task.downloadedBytes = task.fileSize || task.downloadedBytes;
      task.finishedAt = Date.now();
      finished = true;
    } catch (error) {
      if (error instanceof TransferDeferredError && !abort.signal.aborted) {
        task.status = 'pending';
        return;
      }
      if (abort.signal.aborted) {
        task.status = task.interrupted ? 'failed' : 'cancelled';
      } else {
        task.status = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
      }
      task.finishedAt = Date.now();
      finished = true;
    } finally {
      this.publishing.delete(task.id);
      this.transfers.delete(task.id);
      if (task.status !== 'pending') {
        delete task.pausedByPolicy;
        await this.removePartial(task);
      }
      this.aborts.delete(task.id);
      // 结束通知应在临时文件收尾及任务记录保存之后交付。
      if (finished) this.recordTaskLog(task);
      await this.persist();
      if (finished) this.emit('task', task);
    }
  }
}
