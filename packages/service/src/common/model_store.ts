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
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { rm, mkdir, copyFile, constants, lstat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { writeFileAtomicSync } from './atomic_write';

/** One downloadable file within a model (the on-disk name + its source URL). */
export interface ModelFile {
  /** Stable key used in progress weighting (e.g. 'model' | 'tokens'). */
  key: string;
  /** File name on disk inside the model directory. */
  name: string;
  /** Remote download URL. */
  url: string;
  /** 已核实具有相同长度与 SHA-256 的原样下载来源。 */
  sources?: string[];
  /** Fraction of the total download this file represents (weights sum to 1). */
  weight: number;
  /** 固定模型文件的完整性契约；旧注册项未提供时仍检查非空普通文件。 */
  sizeBytes?: number;
  sha256?: string;
}

/** The minimum a registry entry must expose for {@link ModelStore} to manage it. */
export interface ModelEntry {
  /** Stable id, also the on-disk directory name and the config value. */
  id: string;
  minWeqVersion?: string;
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
  source?: string;
  attempt?: number;
  retryAt?: number;
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
  private readonly active = new Map<string, { model: T; directory: string; removed?: boolean }>();
  private readonly transfers = new Map<string, ManagedDownload>();
  private readonly verifiedFiles = new Map<string, { signature: string; valid: boolean }>();
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

  protected constructor(
    modelsRoot: string,
    entries: readonly T[],
    private readonly downloadOptions: { retryBaseMs?: number; maxAttempts?: number } = {},
  ) {
    super();
    this.modelsRoot = modelsRoot;
    this.entries = entries;
    for (const original of entries) {
      try {
        const saved = JSON.parse(readFileSync(this.receiptPath(original.id), 'utf8'));
        if (saved.removed === true) {
          this.restoreRevision(original.id, { removed: true, revision: null });
          continue;
        }
        if (
          !/^[a-f0-9]{64}$/.test(saved.revision) ||
          saved.model?.id !== original.id ||
          !Array.isArray(saved.model.files)
        )
          continue;
        const directory = join(modelsRoot, '.versions', saved.revision, original.id);
        if (
          saved.model.files.some(
            (file: ModelFile) =>
              !file.name ||
              file.name.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'),
          )
        )
          continue;
        this.active.set(original.id, { model: { ...original, ...saved.model }, directory });
      } catch {
        /* 未迁移的模型仍从原目录读取。 */
      }
    }
  }

  /** Look up a registry entry by id. */
  getModel(id: string): T | undefined {
    return this.active.get(id)?.model ?? this.entries.find((m) => m.id === id);
  }
  registeredModel(id: string): T | undefined {
    return this.entries.find((model) => model.id === id);
  }
  installedRevision(id: string): string | null {
    if (this.isRemoved(id)) return null;
    const directory = this.active.get(id)?.directory;
    return directory ? (directory.split(sep).at(-2) ?? null) : null;
  }
  isRemoved(id: string): boolean {
    return this.active.get(id)?.removed === true;
  }
  restoreRevision(id: string, snapshot: unknown): void {
    const original = this.registeredModel(id);
    if (!original || !snapshot || typeof snapshot !== 'object') return;
    const saved = snapshot as { revision?: unknown; model?: unknown; removed?: unknown };
    if (saved.removed === true) {
      this.active.set(id, {
        model: original,
        directory: join(this.modelsRoot, '.removed', id),
        removed: true,
      });
      return;
    }
    if (saved.revision === null) {
      this.active.delete(id);
      return;
    }
    if (
      typeof saved.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(saved.revision) ||
      !saved.model ||
      typeof saved.model !== 'object'
    )
      throw new Error('模型安装记录无效');
    const model = saved.model as ModelEntry;
    if (
      model.id !== id ||
      !Array.isArray(model.files) ||
      model.files.some(
        (file) =>
          !file ||
          typeof file.name !== 'string' ||
          file.name.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') ||
          typeof file.url !== 'string' ||
          !file.sizeBytes ||
          !/^[a-f0-9]{64}$/.test(file.sha256 ?? ''),
      )
    )
      throw new Error('模型安装文件记录无效');
    this.active.set(id, {
      model: { ...original, ...model },
      directory: join(this.modelsRoot, '.versions', saved.revision, id),
    });
  }

  /** Absolute directory for a model's files (not created here). */
  resolveModelDir(id: string): string {
    return this.active.get(id)?.directory ?? join(this.modelsRoot, id);
  }

  private receiptPath(id: string) {
    return join(this.modelsRoot, `.active-${id}.json`);
  }

  /** 更新候选与活动模型隔离；相同内容的文件通过 clone 复用，不复制整套模型。 */
  revisionStore(model: T, revision: string): ModelStore<T> {
    if (!/^[a-f0-9]{64}$/.test(revision) || !this.entries.some((entry) => entry.id === model.id))
      throw new Error('模型版本身份无效');
    class Candidate extends ModelStore<T> {}
    return new Candidate(
      join(this.modelsRoot, '.versions', revision),
      [model],
      this.downloadOptions,
    );
  }

  async reuseInto(candidate: ModelStore<T>, id: string): Promise<void> {
    const original = this.getModel(id);
    const next = candidate.getModel(id);
    if (!original || !next) return;
    for (const file of next.files) {
      const same = original.files.find(
        (entry) =>
          entry.sha256 && entry.sha256 === file.sha256 && entry.sizeBytes === file.sizeBytes,
      );
      const to = join(candidate.resolveModelDir(id), file.name);
      if (await candidate.validFile(to, file)) continue;
      const sources = [
        ...new Set([
          ...(same ? [join(this.resolveModelDir(id), same.name)] : []),
          join(this.modelsRoot, id, file.name),
        ]),
      ];
      let from: string | undefined;
      for (const source of sources)
        if (source !== to && (await this.validFile(source, file))) {
          from = source;
          break;
        }
      if (!from) continue;
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to, constants.COPYFILE_FICLONE);
    }
  }

  /** 统计通过校验的候选及旧资源，不把同长度坏文件算作可复用。 */
  async reusableFiles(candidate: ModelStore<T>, id: string): Promise<Set<string>> {
    const result = new Set<string>();
    const original = this.getModel(id);
    for (const file of candidate.getModel(id)?.files ?? []) {
      const same = original?.files.find(
        (entry) =>
          entry.sha256 && entry.sha256 === file.sha256 && entry.sizeBytes === file.sizeBytes,
      );
      const sources = new Set([
        join(candidate.resolveModelDir(id), file.name),
        ...(same ? [join(this.resolveModelDir(id), same.name)] : []),
        join(this.modelsRoot, id, file.name),
      ]);
      for (const source of sources) {
        if (await this.validFile(source, file)) {
          result.add(file.key);
          break;
        }
      }
    }
    return result;
  }

  activateRevision(candidate: ModelStore<T>, id: string, revision: string): () => void {
    const model = candidate.getModel(id);
    if (
      !model ||
      candidate.resolveModelDir(id) !== join(this.modelsRoot, '.versions', revision, id)
    )
      throw new Error('模型候选目录无效');
    const previous = this.active.get(id);
    const previousReceipt = existsSync(this.receiptPath(id))
      ? readFileSync(this.receiptPath(id), 'utf8')
      : undefined;
    writeFileAtomicSync(this.receiptPath(id), JSON.stringify({ revision, model }));
    this.active.set(id, { model, directory: candidate.resolveModelDir(id) });
    return () => {
      if (previous) this.active.set(id, previous);
      else this.active.delete(id);
      if (previousReceipt) writeFileAtomicSync(this.receiptPath(id), previousReceipt);
      else rmSync(this.receiptPath(id), { force: true });
    };
  }

  async cleanPreviousRevision(
    id: string,
    directory: string,
    legacyModel?: ModelEntry,
  ): Promise<void> {
    if (
      legacyModel &&
      directory !== this.resolveModelDir(id) &&
      directory.startsWith(`${join(this.modelsRoot, '.versions')}${sep}`)
    ) {
      for (const file of legacyModel.files) {
        const path = join(directory, file.name);
        if ((await lstat(path).catch(() => null))?.isFile() && (await this.validFile(path, file)))
          await rm(path, { force: true });
      }
      const record = join(directory, 'model-files.json');
      try {
        if (
          JSON.stringify(JSON.parse(readFileSync(record, 'utf8'))) ===
          JSON.stringify(legacyModel.files)
        )
          await rm(record, { force: true });
      } catch {
        /* 未知附加文件保留。 */
      }
    }
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
    if (this.isRemoved(id))
      return { ...model, downloaded: false, sizeOnDisk: 0, downloading: false };
    const dir = this.resolveModelDir(id);
    let downloaded = true;
    let sizeOnDisk = 0;
    for (const f of model.files) {
      const p = join(dir, f.name);
      try {
        const info = statSync(p);
        sizeOnDisk += info.size;
        if (
          !info.isFile() ||
          !info.size ||
          (f.sizeBytes !== undefined && info.size !== f.sizeBytes)
        )
          downloaded = false;
      } catch {
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
  deleteModel(id: string, rememberRemoval = true): boolean {
    if (!this.getModel(id)) return false;
    if (this.downloadTasks.has(id)) return false;
    if (this.isRemoved(id) && rememberRemoval) return true;
    const dir = this.resolveModelDir(id);
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      if (rememberRemoval) {
        writeFileAtomicSync(this.receiptPath(id), JSON.stringify({ removed: true }));
        this.restoreRevision(id, { removed: true, revision: null });
      } else {
        rmSync(this.receiptPath(id), { force: true });
        this.active.delete(id);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a download for `id` is currently in flight. */
  isDownloading(id: string): boolean {
    return this.downloadTasks.has(id);
  }

  private async validFile(path: string, file: ModelFile): Promise<boolean> {
    try {
      const info = statSync(path);
      if (
        !info.isFile() ||
        !info.size ||
        (file.sizeBytes !== undefined && info.size !== file.sizeBytes)
      )
        return false;
      if (file.sha256) {
        const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${file.sha256}`;
        const previous = this.verifiedFiles.get(path);
        if (previous?.signature === signature) return previous.valid;
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        const valid = hash.digest('hex') === file.sha256;
        const latest = statSync(path);
        if (
          latest.ino !== info.ino ||
          latest.size !== info.size ||
          latest.mtimeMs !== info.mtimeMs ||
          latest.ctimeMs !== info.ctimeMs
        )
          return false;
        if (this.verifiedFiles.size >= 256) {
          const oldest = this.verifiedFiles.keys().next().value;
          if (oldest) this.verifiedFiles.delete(oldest);
        }
        this.verifiedFiles.set(path, { signature, valid });
        if (!valid) return false;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** 只校验现有文件，不修复或发起网络请求。 */
  async verifyModel(id: string): Promise<boolean> {
    if (this.isRemoved(id)) return false;
    const model = this.getModel(id);
    if (!model) return false;
    for (const file of model.files)
      if (!(await this.validFile(join(this.resolveModelDir(id), file.name), file))) return false;
    return true;
  }

  /**
   * Download (or resume by re-downloading) all files of a model. De-duped per
   * id. Emits `'progress'` throughout, and a terminal `'progress'` with either
   * `done:true` or `error`. Returns the terminal result.
   */
  downloadModel(
    id: string,
    sourceOverrides: Readonly<Record<string, string | readonly string[]>> = {},
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isRemoved(id))
      return Promise.resolve({ success: false, error: '模型已删除，请通过增强包重新下载' });
    if (this.isRemoved(id))
      return Promise.resolve({ success: false, error: '模型已删除，请通过增强包重新下载' });
    const pending = this.downloadTasks.get(id);
    if (pending) return pending;
    if (signal?.aborted) return Promise.resolve({ success: false, error: String(signal.reason) });

    const model = this.getModel(id);
    if (!model) {
      const error = `unknown model: ${id}`;
      this.emitProgress({ id, percent: 0, downloadedBytes: 0, totalBytes: 0, speed: 0, error });
      return Promise.resolve({ success: false, error });
    }

    const task = (async (): Promise<{ success: boolean; error?: string }> => {
      const dir = this.resolveModelDir(id);
      let completedBytes = 0;
      let displayedBytes = 0;
      let fileDownloading = false;
      let paused = false;
      let pauseReasons: string[] = [];
      const report = (received: number, patch: Partial<ModelDownloadProgress> = {}) => {
        // 状态回调只包含当前文件；两条事件流统一为整套模型的累计字节。
        // 续传被服务器重置时保持已显示进度，待实际下载追上，不伪造成功终态。
        displayedBytes = Math.max(displayedBytes, received);
        this.emitProgress({
          id,
          percent: model.sizeBytes ? (displayedBytes / model.sizeBytes) * 100 : 0,
          downloadedBytes: displayedBytes,
          totalBytes: model.sizeBytes,
          speed: 0,
          paused,
          pauseReasons,
          ...patch,
        });
      };
      const transfer = new ManagedDownload({
        ...this.downloadOptions,
        ...(signal ? { signal } : {}),
        batch: true,
        total: model.sizeBytes,
        validate: async (path, _response, bytes) => {
          const file = model.files.find((entry) => `${join(dir, entry.name)}.part` === path);
          if (!file || !bytes || !(await this.validFile(path, file))) {
            await rm(path, { force: true });
            throw new Error('模型文件长度或哈希校验失败，请重试');
          }
        },
        state: (state) => {
          paused = state.paused;
          pauseReasons = state.reasons;
          report(completedBytes + (fileDownloading ? state.received : 0), {
            source: state.source,
            attempt: state.attempt,
            retryAt: state.retryAt,
          });
        },
      });
      this.transfers.set(id, transfer);
      try {
        mkdirSync(dir, { recursive: true });
        report(0);
        const reusable = new Set<string>();
        // 复用的文件可能排在后面，先计入基线，避免它们被重复计作本次下载量。
        for (const file of model.files) {
          signal?.throwIfAborted();
          const target = join(dir, file.name);
          if (await this.validFile(target, file)) {
            reusable.add(file.key);
            completedBytes += statSync(target).size;
          }
        }
        report(completedBytes);
        for (const f of model.files) {
          signal?.throwIfAborted();
          const target = join(dir, f.name);
          if (reusable.has(f.key)) continue;
          mkdirSync(dirname(target), { recursive: true });
          fileDownloading = true;
          try {
            await this.downloadToFile(
              sourceOverrides[f.key] ?? f.sources ?? f.url,
              target,
              (downloaded, _total, speed) => report(completedBytes + downloaded, { speed }),
              transfer,
              f,
            );
          } finally {
            fileDownloading = false;
          }
          completedBytes += statSync(target).size;
          report(completedBytes);
        }

        report(this.bytesOnDisk(dir, model), {
          percent: 100,
          done: true,
          paused: false,
          pauseReasons: [],
        });
        return { success: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // 完整文件和带验证信息的分段保留，重试不重复下载已完成部分。
        report(displayedBytes, { error, paused: false, pauseReasons: [] });
        return { success: false, error };
      } finally {
        this.transfers.delete(id);
      }
    })().finally(() => this.downloadTasks.delete(id));

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
    url: string | readonly string[],
    target: string,
    progress: (received: number, total: number, speed: number) => void,
    transfer: ManagedDownload,
    file: ModelFile,
  ): Promise<void> {
    return transfer.file(
      url,
      target,
      COMMON_HEADERS,
      progress,
      file.sha256 && file.sizeBytes ? { sha256: file.sha256, size: file.sizeBytes } : undefined,
    );
  }
}
