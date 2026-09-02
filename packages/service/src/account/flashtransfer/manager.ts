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
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getLogger, logErrorContext } from '../../common/logger';
import { safeRelSegments, sanitizeSegment, uniqueName } from '../../common/path_sanitize';
import { FlashTransferClient } from './client';
import { FlashTransferResolver } from './resolver';
import type { FlashDownloadTask, FlashSelection, FlashTaskStatus } from './types';

const logger = getLogger().child({ scope: 'flash-transfer-download' });

const CONCURRENCY = 4;
const DL_RETRIES = 3;
const DL_BACKOFF_BASE_MS = 300;
/** 同名文件在同一目录下的去重后缀（保留原始目录结构的前提）。 */
const MAX_NAME_LEN = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function backoffMs(n: number): number {
  const base = DL_BACKOFF_BASE_MS * 2 ** n;
  return base + Math.floor(Math.random() * base * 0.4);
}

/** 流式下载到 dest，回调已收到的字节数；可被 AbortController 中断。 */
async function downloadWithProgress(
  url: string,
  dest: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(url, { signal });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < DL_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const ct = res.headers.get('content-type') ?? '';
      if (!res.ok || !res.body || ct.startsWith('text/') || ct.includes('json')) {
        throw new Error(`HTTP ${res.status} ct=${ct || 'n/a'}`);
      }
      const total = Number(res.headers.get('content-length') ?? 0) || 0;
      await mkdir(dirname(dest), { recursive: true });
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          onProgress(received, total);
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        counter,
        createWriteStream(dest),
        { signal },
      );
      return;
    } catch (error) {
      if (
        attempt < DL_RETRIES &&
        !(error instanceof Error && /^HTTP 4/.test(error.message)) &&
        !isAbortError(error)
      ) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export class FlashTransferDownloadManager extends EventEmitter {
  private readonly tasksPath: string;
  private tasks: FlashDownloadTask[] = [];
  private readonly aborts = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private pumping = false;
  private readonly client: FlashTransferClient;
  private readonly resolver: FlashTransferResolver;

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

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.tasksPath, 'utf8');
      const parsed = JSON.parse(raw) as FlashDownloadTask[];
      if (Array.isArray(parsed)) this.tasks = parsed;
    } catch {
      // 首次运行 / 文件损坏：从空列表开始。
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(this.baseDir, { recursive: true });
      await writeFile(this.tasksPath, JSON.stringify(this.tasks, null, 2), 'utf8');
    } catch (error) {
      logger.error('failed to persist flash tasks', {
        event: 'flash-tasks-write',
        ...logErrorContext(error),
      });
    }
  }

  private emitTask(task: FlashDownloadTask): void {
    this.emit('task', task);
  }

  /** 当前全部任务，新的在前。 */
  list(): FlashDownloadTask[] {
    return [...this.tasks].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 解析选择 → 建任务落盘 → 后台并发下载。返回本次新建的任务数和解析期错误。
   * 解析（目录递归）在调用内完成，方便前端一次性拿到“已加入 N 个任务”。
   */
  async start(
    filesetName: string,
    filesetId: string,
    selections: FlashSelection[],
  ): Promise<{ started: number; errors: string[] }> {
    const { files, errors } = await this.resolver.resolveDownloads(selections);
    const now = Date.now();
    const usedByDir = new Map<string, Set<string>>();

    const newTasks: FlashDownloadTask[] = files.map((f) => {
      const segments = safeRelSegments(f.relativePath, { maxLen: MAX_NAME_LEN });
      const dir = join(
        this.baseDir,
        sanitizeSegment(filesetName || filesetId, 'flash', { maxLen: MAX_NAME_LEN }),
        ...segments.slice(0, -1),
      );
      const used = usedByDir.get(dir) ?? new Set<string>();
      usedByDir.set(dir, used);
      const fileName = uniqueName(segments.at(-1) ?? 'file', used);
      return {
        id: randomUUID(),
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
      };
    });

    this.tasks.push(...newTasks);
    await this.persist();
    for (const task of newTasks) this.emitTask(task);
    void this.pump();
    return { started: newTasks.length, errors };
  }

  /** 取消单个任务（进行中的会中断下载）。 */
  async cancel(taskId: string): Promise<boolean> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    if (task.status === 'pending' || task.status === 'resolving' || task.status === 'downloading') {
      this.aborts.get(task.id)?.abort();
      task.status = 'cancelled';
      task.finishedAt = Date.now();
      this.emitTask(task);
      await this.persist();
    }
    return true;
  }

  /** 清掉已结束（完成/失败/取消）的任务；进行中的保留。 */
  async clearFinished(): Promise<number> {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter(
      (t) => t.status === 'pending' || t.status === 'resolving' || t.status === 'downloading',
    );
    const removed = before - this.tasks.length;
    if (removed > 0) await this.persist();
    return removed;
  }

  // ---- 后台调度 ----------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const nextTask = this.tasks.find((t) => t.status === 'pending' && !this.running.has(t.id));
        if (!nextTask || this.running.size >= CONCURRENCY) break;
        this.running.add(nextTask.id);
        void this.runTask(nextTask).finally(() => {
          this.running.delete(nextTask.id);
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runTask(task: FlashDownloadTask): Promise<void> {
    const abort = new AbortController();
    this.aborts.set(task.id, abort);
    try {
      // 取消竞态：cancel() 可能在 pump 调度后才生效，这里每次推进前复查。
      if ((task.status as FlashTaskStatus) === 'cancelled') return;

      // 1) 换直链
      task.status = 'resolving';
      task.error = undefined;
      task.downloadedBytes = 0;
      this.emitTask(task);
      const url = await this.client.getDownloadUrl(task.physicalId);
      if ((task.status as FlashTaskStatus) === 'cancelled') return;

      // 2) 流式下载
      task.status = 'downloading';
      this.emitTask(task);
      await downloadWithProgress(url, task.targetPath, abort.signal, (received) => {
        task.downloadedBytes = received;
        this.emitTask(task);
      });

      task.status = 'done';
      task.downloadedBytes = task.fileSize || task.downloadedBytes;
      task.finishedAt = Date.now();
      this.emitTask(task);
    } catch (error) {
      if (abort.signal.aborted) {
        task.status = 'cancelled';
      } else {
        task.status = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
      }
      task.finishedAt = Date.now();
      this.emitTask(task);
    } finally {
      this.aborts.delete(task.id);
      await this.persist();
    }
  }
}
