/**
 * VoiceTranscribeService — account-independent voice-transcription model
 * management (the first member of `common/`).
 *
 * Scope is deliberately narrow and **zero-native**: a model registry, plus
 * download / status / path / delete over plain Node `https`. The sherpa-onnx
 * recognition engine itself is native and lives in the Electron app (see
 * `apps/desktop/src/main/transcribe/`) — the same split silk-wasm follows
 * (decode lives in the app, not in `@weq/service`).
 *
 * Models are stored under `<appDataRoot>/models/<id>/` — intentionally NOT
 * under the cache directory, so "清空缓存" never nukes a 245 MB model.
 *
 * Emits a single `'progress'` event ({@link DownloadProgress}) during a
 * download so the renderer can drive a progress bar. The IPC layer turns it
 * into a tRPC subscription.
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
import type { Platform } from '@weq/platform';

/** One downloadable file within a model (the on-disk name + its source URL). */
export interface TranscribeModelFile {
  /** Stable key used in progress weighting (e.g. 'model' | 'tokens'). */
  key: string;
  /** File name on disk inside the model directory. */
  name: string;
  /** Remote download URL. */
  url: string;
  /** Fraction of the total download this file represents (weights sum to 1). */
  weight: number;
}

/** A transcription model the user can download and select. */
export interface TranscribeModelInfo {
  /** Stable id, also the on-disk directory name and the config value. */
  id: string;
  /** sherpa-onnx engine kind — drives the worker's recognizer config. */
  engine: 'sense-voice';
  /** Display name. */
  name: string;
  /** One-line description (languages, traits). */
  desc: string;
  /** Total download size in bytes (approximate, for the UI). */
  sizeBytes: number;
  /** Human label for the size (e.g. "245 MB"). */
  sizeLabel: string;
  /** Default language whitelist for this model. */
  languages: string[];
  /** Whether this is the recommended default. */
  recommended: boolean;
  /** Files that make up the model. */
  files: TranscribeModelFile[];
}

/** A model entry enriched with its on-disk / in-flight state. */
export interface TranscribeModelStatus extends TranscribeModelInfo {
  /** All files present on disk. */
  downloaded: boolean;
  /** Total bytes currently on disk (sum of present files). */
  sizeOnDisk: number;
  /** A download is in flight right now. */
  downloading: boolean;
}

/** Progress payload emitted during a download. */
export interface DownloadProgress {
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

const SENSEVOICE_BASE =
  'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master';

/**
 * The model registry. Adding a model is a registry-only change — the worker
 * already branches on `engine`, and the UI renders this list verbatim.
 */
export const VOICE_MODELS: TranscribeModelInfo[] = [
  {
    id: 'sensevoice',
    engine: 'sense-voice',
    name: 'SenseVoice Small',
    desc: '中 / 英 / 日 / 韩 / 粤，离线识别，速度快、体积适中',
    sizeBytes: 245_000_000,
    sizeLabel: '245 MB',
    languages: ['zh', 'yue', 'en', 'ja', 'ko'],
    recommended: true,
    files: [
      { key: 'model', name: 'model.int8.onnx', url: `${SENSEVOICE_BASE}/model.int8.onnx`, weight: 0.8 },
      { key: 'tokens', name: 'tokens.txt', url: `${SENSEVOICE_BASE}/tokens.txt`, weight: 0.2 },
    ],
  },
];

/** Look up a model in the registry by id. */
export function getVoiceModel(id: string): TranscribeModelInfo | undefined {
  return VOICE_MODELS.find((m) => m.id === id);
}

export class VoiceTranscribeService extends EventEmitter {
  private readonly modelsRoot: string;
  /** In-flight downloads keyed by model id (de-dupes concurrent requests). */
  private readonly downloadTasks = new Map<string, Promise<{ success: boolean; error?: string }>>();

  constructor(platform: Platform) {
    super();
    this.modelsRoot = join(platform.appDataRoot(), 'models');
  }

  /** Absolute directory for a model's files (not created here). */
  resolveModelDir(id: string): string {
    return join(this.modelsRoot, id);
  }

  /** Absolute paths to every file of a model, keyed by file key. */
  resolveModelPaths(id: string): Record<string, string> {
    const model = getVoiceModel(id);
    if (!model) return {};
    const dir = this.resolveModelDir(id);
    const out: Record<string, string> = {};
    for (const f of model.files) out[f.key] = join(dir, f.name);
    return out;
  }

  /** Status for one model (existence + bytes on disk + in-flight flag). */
  getModelStatus(id: string): TranscribeModelStatus | undefined {
    const model = getVoiceModel(id);
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
  listModels(): TranscribeModelStatus[] {
    return VOICE_MODELS.map((m) => this.getModelStatus(m.id)!);
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

  /**
   * Download (or resume by re-downloading) all files of a model. De-duped per
   * id. Emits `'progress'` throughout, and a terminal `'progress'` with either
   * `done:true` or `error`. Returns the terminal result.
   */
  downloadModel(id: string): Promise<{ success: boolean; error?: string }> {
    const pending = this.downloadTasks.get(id);
    if (pending) return pending;

    const model = getVoiceModel(id);
    if (!model) {
      const error = `unknown model: ${id}`;
      this.emit('progress', { id, percent: 0, downloadedBytes: 0, totalBytes: 0, speed: 0, error } as DownloadProgress);
      return Promise.resolve({ success: false, error });
    }

    const task = (async (): Promise<{ success: boolean; error?: string }> => {
      const dir = this.resolveModelDir(id);
      try {
        mkdirSync(dir, { recursive: true });
        this.emitProgress(id, 0, 0, model.sizeBytes, 0);

        // Cumulative completed weight from already-finished files, so the
        // overall percentage is monotonic across the multi-file download.
        let baseWeight = 0;
        for (const f of model.files) {
          const target = join(dir, f.name);
          await this.downloadToFile(f.url, target, f.key, (downloaded, total, speed) => {
            const filePercent = total ? downloaded / total : 0;
            const percent = (baseWeight + filePercent * f.weight) * 100;
            this.emitProgress(id, percent, this.bytesOnDisk(dir, model), model.sizeBytes, speed);
          });
          baseWeight += f.weight;
        }

        this.emit('progress', {
          id,
          percent: 100,
          downloadedBytes: this.bytesOnDisk(dir, model),
          totalBytes: model.sizeBytes,
          speed: 0,
          done: true,
        } as DownloadProgress);
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
        this.emit('progress', { id, percent: 0, downloadedBytes: 0, totalBytes: model.sizeBytes, speed: 0, error } as DownloadProgress);
        return { success: false, error };
      } finally {
        this.downloadTasks.delete(id);
      }
    })();

    this.downloadTasks.set(id, task);
    return task;
  }

  /** Whether a download for `id` is currently in flight. */
  isDownloading(id: string): boolean {
    return this.downloadTasks.has(id);
  }

  // ---- internals ----------------------------------------------------------

  private emitProgress(id: string, percent: number, downloadedBytes: number, totalBytes: number, speed: number): void {
    this.emit('progress', {
      id,
      percent: Math.min(100, Math.max(0, percent)),
      downloadedBytes,
      totalBytes,
      speed,
    } as DownloadProgress);
  }

  private bytesOnDisk(dir: string, model: TranscribeModelInfo): number {
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
    if (totalSize < 2 * 1024 * 1024 || !acceptRanges) {
      return this.downloadSingleThread(finalUrl, targetPath, onProgress);
    }

    const threadCount = 4;
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
      throw new Error(`${label} 多线程下载失败: ${err instanceof Error ? err.message : String(err)}`);
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
      const req = protocol.get(url, { headers: { ...COMMON_HEADERS, Range: 'bytes=0-0' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
          const location = res.headers.location;
          if (location && remainingRedirects > 0) {
            const next = new URL(location, url).href;
            res.destroy();
            this.probeUrl(next, remainingRedirects - 1).then(resolve).catch(reject);
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
      });
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
      const req = protocol.get(url, { headers: { ...COMMON_HEADERS, Range: `bytes=${start}-${end}` } }, (res) => {
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
      });
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
            this.downloadSingleThread(next, targetPath, onProgress, remainingRedirects - 1).then(resolve).catch(reject);
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
