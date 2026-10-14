/**
 * Laya ONNX bundle 的本地下载器。
 *
 * `@receptron/laya` 自带的 ensureBundle 只认 huggingface.co（国内不可达），所以
 * 这里自己下同一组文件（文件清单与该包 BUNDLE_FILES 一致），支持 hf-mirror.com
 * 镜像切换。语义对齐该包的 download：远端大小与本地一致则跳过、临时文件 +
 * rename 原子落盘、中断不会留半截权重文件。
 */

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 一个导出的 Laya checkpoint 的全部文件（相对 bundle 根）。 */
export const LAYA_BUNDLE_FILES = [
  'laya.onnx',
  'laya.onnx.data',
  'laya_config.json',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
] as const;

/** 发布 ONNX bundle 的仓库（subfolder multilingual = 多语言 checkpoint）。 */
export const LAYA_REPO = 'receptron/laya-onnx';
export const LAYA_SUBFOLDER = 'multilingual';

export interface BundleProgress {
  /** 已完成的文件数 / 总文件数。 */
  filesDone: number;
  filesTotal: number;
  /** 全部文件的累计字节数进度。 */
  received: number;
  total: number;
  /** 当前正在下的文件名（全部完成时为 null）。 */
  currentFile: string | null;
  /** 全部就绪（含本次调用前已就绪的情况）。 */
  done: boolean;
}

export interface DownloadBundleOptions {
  /** 下载到哪个目录（bundle 根）。 */
  destDir: string;
  /** true 走 hf-mirror.com。 */
  mirror: boolean;
  onProgress?: (p: BundleProgress) => void;
  signal?: AbortSignal;
}

function fileUrl(mirror: boolean, file: string): string {
  const host = mirror ? 'https://hf-mirror.com' : 'https://huggingface.co';
  return `${host}/${LAYA_REPO}/resolve/main/${encodeURIComponent(LAYA_SUBFOLDER)}/${file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

/** bundle 是否已经完整（5 个文件都在）。 */
export function isLayaBundleReady(dir: string): boolean {
  return LAYA_BUNDLE_FILES.every((f) => existsSync(join(dir, f)));
}

async function remoteSize(url: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal, redirect: 'follow' });
    if (!res.ok) return null;
    const len = res.headers.get('content-length');
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

/**
 * 下载（或补齐）Laya bundle。已完整时立即返回 done。单个文件失败直接抛出 ——
 * 调用方（设置页）把错误呈现给用户，重试就是再调一次。
 */
export async function downloadLayaBundle(opts: DownloadBundleOptions): Promise<void> {
  const { destDir, mirror, onProgress, signal } = opts;
  await mkdir(destDir, { recursive: true });

  // 先探一遍远端大小：既做「跳过已下载」的判断，也给总进度一个分母。
  const sizes = new Map<string, number | null>();
  for (const file of LAYA_BUNDLE_FILES) {
    if (signal?.aborted) throw new Error('aborted');
    sizes.set(file, await remoteSize(fileUrl(mirror, file), signal));
  }
  const total = [...sizes.values()].reduce<number>((acc, size) => acc + (size ?? 0), 0);

  let filesDone = 0;
  let received = 0;
  for (const file of LAYA_BUNDLE_FILES) {
    const target = join(destDir, file);
    await mkdir(dirname(target), { recursive: true });
    const remote = sizes.get(file) ?? null;
    try {
      const local = await stat(target);
      if (remote === null || local.isFile()) {
        // 远端大小未知但本地已有：按已知远端大小跳过；远端也未知就重下。
        if (remote === null || local.size === remote) {
          filesDone++;
          received += local.size;
          onProgress?.({
            filesDone,
            filesTotal: LAYA_BUNDLE_FILES.length,
            received,
            total,
            currentFile: null,
            done: filesDone === LAYA_BUNDLE_FILES.length,
          });
          continue;
        }
      }
    } catch {
      /* 不存在 → 正常下载 */
    }

    const res = await fetch(fileUrl(mirror, file), { signal, redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`下载 ${file} 失败：HTTP ${res.status}`);
    }
    const expected = remote ?? Number(res.headers.get('content-length') ?? 0);
    const tmp = `${target}.tmp`;
    let fileReceived = 0;
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      fileReceived += chunk.length;
      onProgress?.({
        filesDone,
        filesTotal: LAYA_BUNDLE_FILES.length,
        received: received + fileReceived,
        total,
        currentFile: file,
        done: false,
      });
    });
    await pipeline(source, createWriteStream(tmp));
    if (expected > 0 && fileReceived !== expected) {
      await rm(tmp, { force: true });
      throw new Error(`下载 ${file} 不完整（${fileReceived}/${expected} 字节）`);
    }
    await rename(tmp, target);
    filesDone++;
    received += fileReceived;
    onProgress?.({
      filesDone,
      filesTotal: LAYA_BUNDLE_FILES.length,
      received,
      total,
      currentFile: null,
      done: filesDone === LAYA_BUNDLE_FILES.length,
    });
  }
}
