/**
 * Laya ONNX bundle 的本地下载器。
 *
 * `@receptron/laya` 自带的 ensureBundle 只认 huggingface.co（国内不可达），且其
 * 默认仓库 `receptron/laya-onnx` 只有英文 checkpoint —— 多语言版发布在
 * `onnx-community/laya-multilingual-ONNX`（fp16），布局不同（onnx/ 子目录、
 * tokenizer 在根、没有 laya_config.json）。这里跨两个仓库取文件并**重组**成
 * `Laya.load({ modelDir })` 期望的布局：
 *
 *   本地文件                        ← 远端
 *   laya.onnx                       ← onnx-community … onnx/model_fp16.onnx
 *   model_fp16.onnx_data            ← onnx-community … onnx/model_fp16.onnx_data
 *   tokenizer/tokenizer.json        ← onnx-community … tokenizer.json
 *   tokenizer/tokenizer_config.json ← onnx-community … tokenizer_config.json
 *   laya_config.json                ← receptron/laya-onnx … laya_config.json
 *
 * 注意 `.onnx_data` **不能**改名：ONNX 图内部记录的外部权重 location 是导出时的
 * 文件名（model_fp16.onnx_data），onnxruntime 按它找文件；`laya.onnx` 本身走显式
 * 路径加载、随便改名。laya_config.json（温度标定）取自英文 checkpoint：温度只
 * 影响分布锐度不影响 choice 排序，score 期望值会有轻微偏差，可接受。
 *
 * 下载语义对齐 @receptron/laya 的 download：远端大小与本地一致则跳过、临时文件
 * + rename 原子落盘、中断不会留半截权重文件。
 */

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 多语言 fp16 checkpoint（transformers.js 社区导出）。 */
const MULTILINGUAL_REPO = 'onnx-community/laya-multilingual-ONNX';
/** 英文 checkpoint —— 只取它的 laya_config.json（温度标定表）。 */
const ENGLISH_REPO = 'receptron/laya-onnx';

/** 每个文件的远端来源与本地落盘路径（相对 bundle 根）。 */
const BUNDLE_SOURCES = [
  {
    repo: MULTILINGUAL_REPO,
    remote: 'onnx/model_fp16.onnx',
    local: 'laya.onnx',
  },
  {
    repo: MULTILINGUAL_REPO,
    remote: 'onnx/model_fp16.onnx_data',
    // 保持导出时的原名（ONNX 图内部引用它），见文件头注释。
    local: 'model_fp16.onnx_data',
  },
  { repo: MULTILINGUAL_REPO, remote: 'tokenizer.json', local: 'tokenizer/tokenizer.json' },
  {
    repo: MULTILINGUAL_REPO,
    remote: 'tokenizer_config.json',
    local: 'tokenizer/tokenizer_config.json',
  },
  { repo: ENGLISH_REPO, remote: 'laya_config.json', local: 'laya_config.json' },
] as const;

/** bundle 的本地文件清单（isLayaBundleReady 与下载循环共用）。 */
const LAYA_BUNDLE_FILES = BUNDLE_SOURCES.map((s) => s.local);

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

function fileUrl(mirror: boolean, repo: string, remote: string): string {
  const host = mirror ? 'https://hf-mirror.com' : 'https://huggingface.co';
  return `${host}/${repo}/resolve/main/${remote.split('/').map(encodeURIComponent).join('/')}`;
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
  for (const src of BUNDLE_SOURCES) {
    if (signal?.aborted) throw new Error('aborted');
    sizes.set(src.local, await remoteSize(fileUrl(mirror, src.repo, src.remote), signal));
  }
  const total = [...sizes.values()].reduce<number>((acc, size) => acc + (size ?? 0), 0);

  let filesDone = 0;
  let received = 0;
  for (const src of BUNDLE_SOURCES) {
    const file = src.local;
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

    const expected = remote ?? 0;
    const tmp = `${target}.tmp`;
    // 断点续传：上次中断留下的 .tmp 直接从其长度处 Range 续拉（CDN 对大权重
    // 文件常中途断连，从头重来 644MB 用户体验太差；206 = 续传命中）。
    let fileReceived = 0;
    try {
      const tmpStat = await stat(tmp);
      if (tmpStat.isFile()) fileReceived = tmpStat.size;
    } catch {
      /* 无 .tmp → 从头下 */
    }
    const rangeHeaders: Record<string, string> = {};
    if (fileReceived > 0) rangeHeaders.range = `bytes=${fileReceived}-`;
    const fileRes = await fetch(fileUrl(mirror, src.repo, src.remote), {
      signal,
      redirect: 'follow',
      headers: rangeHeaders,
    });
    if (fileRes.status === 200 && fileReceived > 0) {
      // 服务端不认 Range（回到全量 200）：作废已有 .tmp 重新下。
      await rm(tmp, { force: true });
      fileReceived = 0;
    }
    if (!fileRes.ok || !fileRes.body) {
      if (fileRes.status === 416) {
        // 已下满但没走到校验（比如上次进程崩在 rename 前）：按完成处理。
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
        continue;
      }
      throw new Error(`下载 ${file} 失败：HTTP ${fileRes.status}`);
    }
    const startOffset = fileReceived;
    const lenFromHeader = Number(fileRes.headers.get('content-length') ?? 0);
    const partialExpected =
      fileRes.status === 206
        ? expected > 0
          ? expected - startOffset
          : lenFromHeader
        : expected > 0
          ? expected
          : lenFromHeader;
    const source = Readable.fromWeb(fileRes.body as Parameters<typeof Readable.fromWeb>[0]);
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
    await pipeline(source, createWriteStream(tmp, { flags: 'a' }));
    const appended = fileReceived - startOffset;
    if (partialExpected > 0 && appended !== partialExpected) {
      throw new Error(`下载 ${file} 不完整（${appended}/${partialExpected} 字节，重试将续传）`);
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
