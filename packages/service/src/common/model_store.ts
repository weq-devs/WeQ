/**
 * ModelStore — 本地模型文件的通用仓库：注册表 + 受控流式下载与续传
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
 * 下载：策略暂停时中止网络请求；资源身份与 Range 校验通过后续写临时文件。
 * 整个仓库共用一条 `'progress'` 事件流（{@link ModelDownloadProgress}），按 id
 * 区分；下载终态必发一条（`done: true` 或 `error`）。IPC 层把它转成 tRPC 订阅。
 *
 * 零原生：纯 Node（`fs` / `fetch`）。真正的推理引擎住在 app 侧（语音是
 * `apps/desktop/src/main/transcribe/`）。
 */

import { EventEmitter } from 'node:events';
import { ManagedDownload } from './managed_download';
import { existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
  paused?: boolean;
  pauseReasons?: string[];
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

export abstract class ModelStore<T extends ModelEntry> extends EventEmitter {
  private readonly transfers = new Map<string, ManagedDownload>();
  pauseDownload(id: string) {
    this.transfers.get(id)?.pause();
  }
  continueDownload(id: string) {
    this.transfers.get(id)?.continue();
  }
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
      const transfer = new ManagedDownload({
        batch: true,
        total: model.sizeBytes,
        state: (state) => {
          this.emitProgress({
            id,
            percent: state.total ? (state.received / state.total) * 100 : 0,
            downloadedBytes: state.received,
            totalBytes: state.total,
            speed: 0,
            paused: state.paused,
            pauseReasons: state.reasons,
          });
        },
      });
      this.transfers.set(id, transfer);
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
          if (existsSync(target)) {
            baseWeight += f.weight;
            continue;
          }
          await this.downloadToFile(
            f.url,
            target,
            (downloaded, total, speed) => {
              const filePercent = total ? downloaded / total : 0;
              const percent = (baseWeight + filePercent * f.weight) * 100;
              this.emitProgress({
                id,
                percent,
                downloadedBytes: this.bytesOnDisk(dir, model),
                totalBytes: model.sizeBytes,
                speed,
              });
            },
            transfer,
          );
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
        // 完整文件和带验证信息的分段保留，重试不重复下载已完成部分。
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
        this.transfers.delete(id);
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

  private downloadToFile(
    url: string,
    target: string,
    progress: (received: number, total: number, speed: number) => void,
    transfer: ManagedDownload,
  ): Promise<void> {
    return transfer.file(url, target, COMMON_HEADERS, progress);
  }
}
