/**
 * ModelStore — 本地模型文件的通用仓库：注册表 + 下载（多线程分片 / 单线程流式）
 * + 进度事件 + 状态查询 + 删除。
 *
 * 抽这一层的理由：语音转录（`voice_transcribe.ts`）和图片文字识别
 * （`ocr_models.ts`）需要的是**同一套机制**，差别只在注册表条目的语义（引擎、
 * 语种、用途…）。这里只做**文件级**的事，不认识任何模型语义 —— 子类把自己的
 * registry 交进来，完整条目类型留在子类里。
 *
 * 存储约定：`<modelsRoot>/<id>/<file.name>`。`id` 全局唯一，直接当目录名；
 * **故意不放在 cache 目录下** —— 「清空缓存」不该把几百 MB 的模型一起清掉。
 *
 * 下载：服务端支持 Range 且文件 ≥ 2 MB 走 4 线程分片，否则退回单线程流式。
 * 整个仓库共用一条 `'progress'` 事件流（{@link ModelDownloadProgress}），按 id
 * 区分；下载终态必发一条（`done: true` 或 `error`）。IPC 层把它转成 tRPC 订阅。
 *
 * 零原生：纯 Node（`fs` / `http` / `https`）。真正的推理引擎住在 app 侧（语音是
 * `apps/desktop/src/main/transcribe/`）。
 */

import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  rmSync,
  createWriteStream,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';

/** One downloadable file within a model (the on-disk name + its source URL). */
export interface ModelFile {
  /** Stable key used in progress weighting (e.g. 'model' | 'tokens'). */
  key: string;
  /** File name on disk inside the model directory. */
  name: string;
  /** Remote download URL. */
  url: string;
  /** Fraction of the total download this file represents (weights sum to 1). */
  weight: number;
}

/** The minimum a registry entry must expose for {@link ModelStore} to manage it. */
export interface ModelEntry {
  /** Stable id, also the on-disk directory name and the config value. */
  id: string;
  /** Total download size in bytes (approximate, for the UI). */
  sizeBytes: number;
  /** Files that make up the model. */
  files: ModelFile[];
}

/** A model entry enriched with its on-disk / in-flight state. */
export interface ModelDiskState {
  /** All files present on disk. */
  downloaded: boolean;
  /** Total bytes currently on disk (sum of present files). */
  sizeOnDisk: number;
  /** A download is in flight right now. */
  downloading: boolean;
}

/** Progress payload emitted during a download. */
export interface ModelDownloadProgress {
  /** Model id being downloaded. */
  id: string;
  /** 0–100. */
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  /** Bytes/sec (rolling, ~1s window). */
  speed: number;
  /** Set on the terminal event when the download failed. */
  error?: string;
  /** True on the terminal success event. */
  done?: boolean;
}

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://modelscope.cn/',
} as const;

/** 低于这个体积就单线程拉 —— 开 4 个连接省下的时间还不如握手多。 */
const MULTITHREAD_MIN_BYTES = 2 * 1024 * 1024;
/** 分片数。 */
const MULTITHREAD_CHUNKS = 4;

export abstract class ModelStore<T extends ModelEntry> extends EventEmitter {
  private readonly modelsRoot: string;
  private readonly entries: readonly T[];
  /** In-flight downloads keyed by model id (de-dupes concurrent requests). */
  private readonly downloadTasks = new Map<string, Promise<{ success: boolean; error?: string }>>();

  protected constructor(modelsRoot: string, entries: readonly T[]) {
    super();
    this.modelsRoot = modelsRoot;
    this.entries = entries;
  }

  /** Look up a registry entry by id. */
  getModel(id: string): T | undefined {
    return this.entries.find((m) => m.id === id);
  }

  /** Absolute directory for a model's files (not created here). */
  resolveModelDir(id: string): string {
    return join(this.modelsRoot, id);
  }

  /** Absolute paths to every file of a model, keyed by file key. */
  resolveModelPaths(id: string): Record<string, string> {
    const model = this.getModel(id);
    if (!model) return {};
    const dir = this.resolveModelDir(id);
    const out: Record<string, string> = {};
    for (const f of model.files) out[f.key] = join(dir, f.name);
    return out;
  }

  /** Status for one model (existence + bytes on disk + in-flight flag). */
  getModelStatus(id: string): (T & ModelDiskState) | undefined {
    const model = this.getModel(id);
    if (!model) return undefined;
    const dir = this.resolveModelDir(id);
    let downloaded = true;
    let sizeOnDisk = 0;
    for (const f of model.files) {
      const p = join(dir, f.name);
      if (existsSync(p)) {
        try {
          sizeOnDisk += statSync(p).size;
        } catch {
          /* ignore */
        }
      } else {
        downloaded = false;
      }
    }
    return { ...model, downloaded, sizeOnDisk, downloading: this.downloadTasks.has(id) };
  }

  /** Full registry, each entry enriched with on-disk / in-flight state. */
  listModels(): (T & ModelDiskState)[] {
    return this.entries.map((m) => this.getModelStatus(m.id)!);
  }

  /** Delete a downloaded model's directory. No-op if absent or downloading. */
  deleteModel(id: string): boolean {
    if (this.downloadTasks.has(id)) return false;
    const dir = this.resolveModelDir(id);
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a download for `id` is currently in flight. */
  isDownloading(id: string): boolean {
    return this.downloadTasks.has(id);
  }

  /**
   * Download (or resume by re-downloading) all files of a model. De-duped per
   * id. Emits `'progress'` throughout, and a terminal `'progress'` with either
   * `done:true` or `error`. Returns the terminal result.
   */
  downloadModel(id: string): Promise<{ success: boolean; error?: string }> {
    const pending = this.downloadTasks.get(id);
    if (pending) return pending;

    const model = this.getModel(id);
    if (!model) {
      const error = `unknown model: ${id}`;
      this.emitProgress({ id, percent: 0, downloadedBytes: 0, totalBytes: 0, speed: 0, error });
      return Promise.resolve({ success: false, error });
    }

    const task = (async (): Promise<{ success: boolean; error?: string }> => {
      const dir = this.resolveModelDir(id);
      try {
        mkdirSync(dir, { recursive: true });
        this.emitProgress({
          id,
          percent: 0,
          downloadedBytes: 0,
          totalBytes: model.sizeBytes,
          speed: 0,
        });

        // Cumulative completed weight from already-finished files, so the
        // overall percentage is monotonic across the multi-file download.
        let baseWeight = 0;
        for (const f of model.files) {
          const target = join(dir, f.name);
          await this.downloadToFile(f.url, target, f.key, (downloaded, total, speed) => {
            const filePercent = total ? downloaded / total : 0;
            const percent = (baseWeight + filePercent * f.weight) * 100;
            this.emitProgress({
              id,
              percent,
              downloadedBytes: this.bytesOnDisk(dir, model),
              totalBytes: model.sizeBytes,
              speed,
            });
          });
          baseWeight += f.weight;
        }

        this.emitProgress({
          id,
          percent: 100,
          downloadedBytes: this.bytesOnDisk(dir, model),
          totalBytes: model.sizeBytes,
          speed: 0,
          done: true,
        });
        return { success: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // Clean up partial files so a retry starts clean.
        for (const f of model.files) {
          const p = join(dir, f.name);
          try {
            if (existsSync(p)) unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
        this.emitProgress({
          id,
          percent: 0,
          downloadedBytes: 0,
          totalBytes: model.sizeBytes,
          speed: 0,
          error,
        });
        return { success: false, error };
      } finally {
        this.downloadTasks.delete(id);
      }
    })();

    this.downloadTasks.set(id, task);
    return task;
  }

  // ---- internals ----------------------------------------------------------

  private emitProgress(p: ModelDownloadProgress): void {
    this.emit('progress', { ...p, percent: Math.min(100, Math.max(0, p.percent)) });
  }

  private bytesOnDisk(dir: string, model: ModelEntry): number {
    let sum = 0;
    for (const f of model.files) {
      const p = join(dir, f.name);
      if (existsSync(p)) {
        try {
          sum += statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
    return sum;
  }

  /**
   * Download a single file, using a 4-thread ranged download when the server
   * supports it (and the file is large enough), else a single-thread stream.
   * Ported from the WeFlow reference implementation.
   */
  private async downloadToFile(
    url: string,
    targetPath: string,
    label: string,
    onProgress?: (downloaded: number, total: number, speed: number) => void,
  ): Promise<void> {
    if (existsSync(targetPath)) unlinkSync(targetPath);

    let probe: { totalSize: number; acceptRanges: boolean; finalUrl: string };
    try {
      probe = await this.probeUrl(url);
    } catch {
      return this.downloadSingleThread(url, targetPath, onProgress);
    }

    const { totalSize, acceptRanges, finalUrl } = probe;
    if (totalSize < MULTITHREAD_MIN_BYTES || !acceptRanges) {
      return this.downloadSingleThread(finalUrl, targetPath, onProgress);
    }

    const threadCount = MULTITHREAD_CHUNKS;
    const chunkSize = Math.ceil(totalSize / threadCount);
    const fd = openSync(targetPath, 'w');

    let downloadedTotal = 0;
    let lastDownloaded = 0;
    let lastTime = Date.now();

    const speedTimer = setInterval(() => {
      const now = Date.now();
      const dur = (now - lastTime) / 1000;
      if (dur > 0) {
        const speed = (downloadedTotal - lastDownloaded) / dur;
        lastDownloaded = downloadedTotal;
        lastTime = now;
        onProgress?.(downloadedTotal, totalSize, speed);
      }
    }, 1000);

    try {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < threadCount; i += 1) {
        const start = i * chunkSize;
        const end = i === threadCount - 1 ? totalSize - 1 : (i + 1) * chunkSize - 1;
        promises.push(
          this.downloadChunk(finalUrl, fd, start, end, (bytes) => {
            downloadedTotal += bytes;
          }),
        );
      }
      await Promise.all(promises);
      onProgress?.(totalSize, totalSize, 0);
    } catch (err) {
      throw new Error(
        `${label} 多线程下载失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearInterval(speedTimer);
      closeSync(fd);
    }
  }

  private probeUrl(
    url: string,
    remainingRedirects = 5,
  ): Promise<{ totalSize: number; acceptRanges: boolean; finalUrl: string }> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.get(
        url,
        { headers: { ...COMMON_HEADERS, Range: 'bytes=0-0' } },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            const location = res.headers.location;
            if (location && remainingRedirects > 0) {
              const next = new URL(location, url).href;
              res.destroy();
              this.probeUrl(next, remainingRedirects - 1)
                .then(resolve)
                .catch(reject);
              return;
            }
          }
          if (res.statusCode !== 206 && res.statusCode !== 200) {
            reject(new Error(`Probe failed: HTTP ${res.statusCode}`));
            res.destroy();
            return;
          }
          const contentRange = res.headers['content-range'];
          let totalSize = 0;
          if (contentRange) {
            const parts = contentRange.split('/');
            totalSize = parseInt(parts[parts.length - 1] ?? '0', 10);
          } else {
            totalSize = parseInt(res.headers['content-length'] ?? '0', 10);
          }
          const acceptRanges = res.headers['accept-ranges'] === 'bytes' || Boolean(contentRange);
          resolve({ totalSize, acceptRanges, finalUrl: url });
          res.destroy();
        },
      );
      req.on('error', reject);
    });
  }

  private downloadChunk(
    url: string,
    fd: number,
    start: number,
    end: number,
    onData: (bytes: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.get(
        url,
        { headers: { ...COMMON_HEADERS, Range: `bytes=${start}-${end}` } },
        (res) => {
          if (res.statusCode !== 206) {
            reject(new Error(`Chunk download failed: HTTP ${res.statusCode}`));
            res.destroy();
            return;
          }
          let offset = start;
          res.on('data', (chunk: Buffer) => {
            try {
              writeSync(fd, chunk, 0, chunk.length, offset);
              offset += chunk.length;
              onData(chunk.length);
            } catch (err) {
              reject(err);
              res.destroy();
            }
          });
          res.on('end', () => resolve());
          res.on('error', reject);
        },
      );
      req.on('error', reject);
    });
  }

  private downloadSingleThread(
    url: string,
    targetPath: string,
    onProgress?: (downloaded: number, total: number, speed: number) => void,
    remainingRedirects = 5,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.get(url, { headers: COMMON_HEADERS }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
          const location = res.headers.location;
          if (location && remainingRedirects > 0) {
            const next = new URL(location, url).href;
            res.destroy();
            this.downloadSingleThread(next, targetPath, onProgress, remainingRedirects - 1)
              .then(resolve)
              .catch(reject);
            return;
          }
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          res.destroy();
          return;
        }
        const total = Number(res.headers['content-length'] ?? 0) || 0;
        let downloaded = 0;
        let lastDownloaded = 0;
        let lastTime = Date.now();
        const speedTimer = setInterval(() => {
          const now = Date.now();
          const dur = (now - lastTime) / 1000;
          if (dur > 0) {
            const speed = (downloaded - lastDownloaded) / dur;
            lastDownloaded = downloaded;
            lastTime = now;
            onProgress?.(downloaded, total, speed);
          }
        }, 1000);

        const writer = createWriteStream(targetPath);
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
        });
        writer.on('finish', () => {
          clearInterval(speedTimer);
          writer.close();
          onProgress?.(total || downloaded, total || downloaded, 0);
          resolve();
        });
        writer.on('error', (err) => {
          clearInterval(speedTimer);
          writer.destroy();
          reject(err);
        });
        res.on('error', (err) => {
          clearInterval(speedTimer);
          writer.destroy();
          reject(err);
        });
        res.pipe(writer);
      });
      req.on('error', reject);
    });
  }
}
