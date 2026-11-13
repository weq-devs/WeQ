import { dirname, basename, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { ModelStore, type ModelEntry, type ModelDownloadProgress } from '@weq/service';

const MULTILINGUAL =
  'onnx-community/laya-multilingual-ONNX/resolve/46b77bbf5642fec5f14e540570228a8cbe8ab81f';
const ENGLISH = 'receptron/laya-onnx/resolve/d42786bdff8a7550316339c5fbf8f46caa83ea1b';

// 固定上游提交及 LFS 内容身份；外部权重保持图内引用的文件名。
export const LAYA_BUNDLE_SOURCES = [
  {
    repo: MULTILINGUAL,
    remote: 'onnx/model_fp16.onnx',
    local: 'laya.onnx',
    size: 3_572_287,
    sha256: '81f641e21289ddb2cd8ac774c1cddebfdb0fa7e4b183e49ad476d2faee46d98a',
  },
  {
    repo: MULTILINGUAL,
    remote: 'onnx/model_fp16.onnx_data',
    local: 'model_fp16.onnx_data',
    size: 643_817_472,
    sha256: '3c9eb52f5f795f76d7a681197228131fac7e92c3e5a4c90b68ec4065699ee4cf',
  },
  {
    repo: MULTILINGUAL,
    remote: 'tokenizer.json',
    local: 'tokenizer/tokenizer.json',
    size: 34_363_188,
    sha256: '609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f',
  },
  {
    repo: MULTILINGUAL,
    remote: 'tokenizer_config.json',
    local: 'tokenizer/tokenizer_config.json',
    size: 502,
    sha256: '424b69444bf7b5809dc2cd2e36d0bd71b8055124dd24274d6db3c655d38205e7',
  },
  {
    repo: ENGLISH,
    remote: 'laya_config.json',
    local: 'laya_config.json',
    size: 355,
    sha256: 'c4fab3dd16b6ffdb432ae99334c77fca31e1b4beb0b81be76ca45f707709706a',
  },
] as const;
export const LAYA_BUNDLE_BYTES = LAYA_BUNDLE_SOURCES.reduce((sum, file) => sum + file.size, 0);

export interface BundleProgress {
  filesDone: number;
  filesTotal: number;
  received: number;
  total: number;
  currentFile: string | null;
  done: boolean;
  paused?: boolean;
  pauseReasons?: string[];
}

export interface DownloadBundleOptions {
  destDir: string;
  mirror: boolean;
  onProgress?: (p: BundleProgress) => void;
}

export function isLayaBundleReady(dir: string): boolean {
  return LAYA_BUNDLE_SOURCES.every((file) => {
    try {
      const info = statSync(join(dir, file.local));
      return info.isFile() && info.size === file.size;
    } catch {
      return false;
    }
  });
}

class LayaStore extends ModelStore<ModelEntry> {
  constructor(dir: string, mirror: boolean) {
    const host = mirror ? 'https://hf-mirror.com' : 'https://huggingface.co';
    super(dirname(dir), [
      {
        id: basename(dir),
        sizeBytes: LAYA_BUNDLE_BYTES,
        files: LAYA_BUNDLE_SOURCES.map((file) => ({
          key: file.local,
          name: file.local,
          url: `${host}/${file.repo}/${file.remote}`,
          weight: file.size / LAYA_BUNDLE_BYTES,
          sizeBytes: file.size,
          sha256: file.sha256 || undefined,
        })),
      },
    ]);
  }
}

const stores = new Map<string, LayaStore>();
export function layaBundleStore(dir: string, mirror = true): LayaStore {
  let store = stores.get(dir);
  if (!store?.isDownloading(basename(dir))) {
    store = new LayaStore(dir, mirror);
    stores.set(dir, store);
  }
  return store;
}

/** 与 OCR/语音共用受控下载、Range 身份校验、暂停和完整性检查，不另建临时副本。 */
export async function downloadLayaBundle(opts: DownloadBundleOptions): Promise<void> {
  const store = layaBundleStore(opts.destDir, opts.mirror);
  const report = (progress: ModelDownloadProgress) =>
    opts.onProgress?.({
      filesDone: LAYA_BUNDLE_SOURCES.filter((file) => existsSync(join(opts.destDir, file.local)))
        .length,
      filesTotal: LAYA_BUNDLE_SOURCES.length,
      received: progress.downloadedBytes,
      total: progress.totalBytes,
      currentFile: null,
      done: !!progress.done,
      paused: progress.paused,
      pauseReasons: progress.pauseReasons,
    });
  store.on('progress', report);
  try {
    const result = await store.downloadModel(basename(opts.destDir));
    if (!result.success) throw new Error(result.error ?? '意图模型下载失败');
  } finally {
    store.off('progress', report);
  }
}
