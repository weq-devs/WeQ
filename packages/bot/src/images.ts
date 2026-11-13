import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AiImageProcessor,
  imageDescriptionCache,
  type AiImageRef,
  type UsageSink,
} from '@weq/agentlab';
import { judgeTextBoxes } from '@weq/agentlab/ocr/filter';
import type { OcrWorkerMessage, OcrWorkerParams } from '@weq/agentlab/ocr/worker';
import { OcrModelService, localOcrBlocker } from '@weq/service/ocr-models';
import { ocrCacheFor } from '@weq/service/ocr-cache';
import type { BotConfig } from './config';
import { buildEndpointResolver } from './config';
import type { OneBot11Adapter } from './adapter/types';

const requireOptional = createRequire(import.meta.url);
const MAX_BYTES = 32 * 1024 * 1024;
function mime(bytes: Buffer) {
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (bytes.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) return 'image/png';
  throw new Error('图片格式不可用');
}
async function download(url: string, signal?: AbortSignal): Promise<Buffer> {
  if (!/^https?:\/\//.test(url)) throw new Error('图片 URL 不可用');
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) throw new Error(`图片下载失败 (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > MAX_BYTES) throw new Error('图片超过 32 MiB');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export function createBotImages(
  config: BotConfig,
  dataDir: string,
  adapter: OneBot11Adapter,
  usage?: UsageSink,
) {
  const models = new OcrModelService({ appDataRoot: () => dataDir } as ConstructorParameters<
    typeof OcrModelService
  >[0]);
  const resolver = buildEndpointResolver(config.llmProviders);
  const ocrCache = ocrCacheFor(join(dataDir, 'ocr-cache'));
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'ocrWorker.mjs');
  const resolveFile = async (image: AiImageRef, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (image.path) {
      const path = resolve(dataDir, image.path);
      if (path.startsWith(resolve(dataDir) + sep) && existsSync(path)) return path;
    }
    let bytes: Buffer | undefined;
    if (image.url)
      try {
        bytes = await download(image.url, signal);
      } catch {
        signal?.throwIfAborted();
      }
    if (!bytes && image.file) {
      const raw = await adapter.callAction('get_image', { file: image.file });
      if (!raw || typeof raw !== 'object') throw new Error('get_image 未返回图片信息');
      const result = raw as { url?: unknown; file?: unknown };
      if (typeof result.url === 'string')
        try {
          bytes = await download(result.url, signal);
        } catch {
          signal?.throwIfAborted();
        }
      if (!bytes && typeof result.file === 'string' && isAbsolute(result.file)) {
        if ((await stat(result.file)).size > MAX_BYTES) throw new Error('图片超过 32 MiB');
        bytes = await readFile(result.file);
      }
    }
    signal?.throwIfAborted();
    if (!bytes?.length || bytes.length > MAX_BYTES) throw new Error('未能取回图片');
    mime(bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const path = join(dataDir, 'images', `${hash}.bin`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    image.path = relative(dataDir, path);
    delete image.url;
    delete image.file;
    return path;
  };
  const infer = async (path: string, kind: 'filter' | 'ocr', signal?: AbortSignal) => {
    const blocker = localOcrBlocker();
    if (blocker) throw new Error(blocker);
    const selected = kind === 'ocr' ? config.images?.ocrModelId : config.images?.filterModelId;
    const available = models
      .listByKind(kind)
      .filter((model) => model.downloaded && !model.downloading);
    const model =
      available.find((model) => model.id === selected) ??
      available.find((model) => model.recommended) ??
      available[0];
    if (!model) throw new Error(kind === 'filter' ? '未下载筛图模型' : '未下载本地识别模型');
    if (!existsSync(workerPath)) throw new Error('OCR worker 未安装，请重新导出 Bot');
    type Decoder = (
      input: Buffer,
      options: { limitInputPixels: number },
    ) => {
      rotate(): {
        removeAlpha(): {
          toColourspace(value: string): {
            raw(): {
              toBuffer(options: {
                resolveWithObject: true;
              }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
            };
          };
        };
      };
    };
    let sharp: Decoder;
    try {
      sharp = requireOptional('sharp') as Decoder;
      requireOptional.resolve('onnxruntime-node');
    } catch {
      throw new Error('本地 OCR 依赖未安装：请在 Bot 目录安装 sharp 和 onnxruntime-node');
    }
    const bytes = await readFile(path);
    const pixels = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 })
      .rotate()
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    signal?.throwIfAborted();
    const paths = models.resolveModelPaths(model.id);
    return new Promise<{
      lines: Extract<OcrWorkerMessage, { type: 'final' }>['lines'];
      modelId: string;
      width: number;
      height: number;
    }>((resolve, reject) => {
      const child = fork(workerPath, [], {
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
      });
      const timer = setTimeout(() => finish(new Error('OCR 推理超时')), 60_000);
      const abort = () => finish(new DOMException('已取消', 'AbortError'));
      let done = false;
      const finish = (error?: Error, message?: Extract<OcrWorkerMessage, { type: 'final' }>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        child.kill();
        if (error) reject(error);
        else
          resolve({
            lines: message!.lines,
            modelId: model.id,
            width: pixels.info.width,
            height: pixels.info.height,
          });
      };
      child.once('error', (error) => finish(error));
      child.once('exit', () => {
        if (!done) finish(new Error('OCR 子进程提前退出'));
      });
      child.on('message', (message: OcrWorkerMessage) =>
        message.type === 'error' ? finish(new Error(message.error)) : finish(undefined, message),
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      child.send({
        mode: kind === 'filter' ? 'detect' : 'ocr',
        width: pixels.info.width,
        height: pixels.info.height,
        data: pixels.data,
        det: paths.det!,
        rec: paths.rec,
        cls: paths.cls,
        dict: paths.dict,
        threads: 2,
      } satisfies OcrWorkerParams);
    });
  };
  const processor = new AiImageProcessor({
    ...imageDescriptionCache(join(dataDir, 'image-descriptions')),
    mode: () => config.images?.mode ?? 'vision',
    vision: (input) =>
      config.images?.visionModel
        ? {
            ...resolver(config.images.visionModel),
            onUsage: (entry) =>
              usage?.record({
                ...entry,
                ts: entry.startedAt ?? Date.now(),
                scope: 'chat',
                personaId: input.personaId,
              }),
          }
        : null,
    load: async (image, signal) => {
      const path = await resolveFile(image, signal);
      const bytes = await readFile(path);
      return {
        dataUrl: `data:${mime(bytes)};base64,${bytes.toString('base64')}`,
        key: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    ocr: async (image, signal) => {
      const path = await resolveFile(image, signal);
      const key = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      const ocrModels = models
        .listByKind('ocr')
        .filter((model) => model.downloaded && !model.downloading);
      const selectedOcr =
        ocrModels.find((model) => model.id === config.images?.ocrModelId) ??
        ocrModels.find((model) => model.recommended) ??
        ocrModels[0];
      const cached = await ocrCache.getText(key, 'local');
      if (cached && cached.modelId === selectedOcr?.id)
        return { text: cached.text, notes: ['复用本地识别缓存。'] };
      const notes: string[] = [];
      if (config.images?.prefilterEnabled !== false) {
        try {
          const filterModels = models
            .listByKind('filter')
            .filter((model) => model.downloaded && !model.downloading);
          const filterModel =
            filterModels.find((model) => model.id === config.images?.filterModelId) ??
            filterModels.find((model) => model.recommended) ??
            filterModels[0];
          const cachedFilter = filterModel ? await ocrCache.getFilter(key, filterModel.id) : null;
          if (cachedFilter && !cachedFilter.hasText)
            return { text: '', skipped: true, notes: ['复用无文字筛图缓存。'] };
          if (!cachedFilter) {
            const filter = await infer(path, 'filter', signal);
            const verdict = judgeTextBoxes(filter.lines, filter.width, filter.height);
            await ocrCache.putFilter(key, filter.modelId, verdict);
            if (!verdict.hasText) return { text: '', skipped: true, notes: ['筛图未检测到文字。'] };
          }
        } catch (error) {
          signal?.throwIfAborted();
          notes.push(
            `筛图不可用，继续 OCR：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const result = await infer(path, 'ocr', signal);
      const text = result.lines.map((line) => line.text).join('\n');
      await ocrCache.putText(key, `local:${result.modelId}`, {
        text,
        modelId: result.modelId,
        frame: { width: result.width, height: result.height, variant: 'original' },
      });
      return { text, notes: [...notes, `使用本地 OCR（${result.modelId}）。`] };
    },
  });
  return { processor, models };
}
