import { dirname, basename, join } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { ModelStore, type ModelEntry, type ModelDownloadProgress } from '@weq/service';
import { LAYA_BUNDLE_SOURCES, layaModelEntry } from '../../shared/laya_bundle';

// 清单与入口定义挪到 shared/laya_bundle.ts（零运行时依赖），打包脚本会直接
// import 那份常量；这里保留同名导出，调用方无需改。
export { LAYA_BUNDLE_BYTES, LAYA_BUNDLE_SOURCES, layaModelEntry } from '../../shared/laya_bundle';

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
  try {
    const files: unknown = JSON.parse(readFileSync(join(dir, 'model-files.json'), 'utf8'));
    if (
      Array.isArray(files) &&
      files.length === LAYA_BUNDLE_SOURCES.length &&
      files.every(
        (file) =>
          file &&
          typeof file.name === 'string' &&
          !file.name.split(/[\\/]/).some((part: string) => part === '..' || part === '.') &&
          Number.isSafeInteger(file.sizeBytes),
      )
    )
      return files.every((file) => statSync(join(dir, file.name)).size === file.sizeBytes);
  } catch {
    /* 旧模型沿用固定清单。 */
  }
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
    super(dirname(dir), [layaModelEntry(mirror, basename(dir))]);
  }
}

const stores = new Map<string, LayaStore>();
export function layaBundleStore(dir: string, mirror = true): LayaStore {
  let store = stores.get(dir);
  if (!store) {
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
