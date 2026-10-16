/**
 * 本地 OCR 引擎 —— 主进程这一侧。
 *
 * `fork` 出 `ocrWorker.mjs`（electron-vite 的独立入口），把裸 RGB + 模型路径发过去，
 * 拿回逐行结果，再整成与**在线那条线同构**的 `OcrBlock`（`text` / `quad` / `rect` /
 * `parag` / `field2`，见 `@weq/protocol` 的 `OcrImage`）—— 于是前端（灯箱覆盖层、
 * `OcrTextPanel`）不用区分结果是从哪来的。
 *
 * 与语音那条线同构的分工：模型的**下载 / 存储 / 选择**在 `@weq/service`（零原生），
 * 这里只负责跑引擎。
 */

import { fork } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrBlock } from '@weq/protocol';
import { resolveChildWorkerPath } from '../worker_path';
// 只引**类型**：管线本体（`pipeline.ts`）由 worker 独享，主进程这边带上它的运行时
// 会让 rollup 把两端共用的模块抽成一个独立 chunk，而 worker 是 fork 出去单独运行的
// 文件（打包时被拷出 asar）—— 多一个相对 import 就多一处「打包后找不到模块」的坑。
import type { DetOptions, OcrRect, RgbImage } from './pipeline';
import type { OcrWorkerLine, OcrWorkerMessage, OcrWorkerParams } from './worker';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 定位打好的 `ocrWorker.mjs` —— 交给共用的 {@link resolveChildWorkerPath}：
 * 打包态用 `extraResources` 拷到 `<resources>/out/main/` 的真文件（**asar 里的文件 fork
 * 不了**，子进程读不到 asar），开发态在 main 产物旁边（可能在 out/main/chunks/）。
 */
function resolveWorkerPath(): string {
  return resolveChildWorkerPath('ocrWorker.mjs', __dirname);
}

export interface OcrEnginePaths {
  /** 检测模型（必给）。 */
  det: string;
  /** 识别模型（`mode: 'ocr'` 时必给）。 */
  rec?: string;
  /** 方向分类模型（可选）。 */
  cls?: string;
  /** 识别字典（`mode: 'ocr'` 时必给）。 */
  dict?: string;
}

export interface OcrEngineRequest {
  image: RgbImage;
  paths: OcrEnginePaths;
  /** `ocr` = 出文字；`detect` = 只出框（筛图用）。 */
  mode?: 'ocr' | 'detect';
  detOptions?: Partial<DetOptions>;
  /**
   * 推理线程数（缺省 = min(8, 核数)）。批量跑多个 worker 时调小，别把核数吃满 ——
   * 筛图那条路一次并发好几个进程，每个都开 8 线程只会互相抢。
   */
  threads?: number;
}

export interface OcrEngineResult {
  ok: boolean;
  /** 与在线版同构的文字块（`mode: 'detect'` 时 `text` 为空）。 */
  blocks: OcrBlock[];
  /** 识别用的图宽 / 高（= 喂进去那张图的像素尺寸，覆盖层按它换算）。 */
  imageWidth: number;
  imageHeight: number;
  elapsedMs: number;
  /** 失败原因（给人看的中文短句）。 */
  error?: string;
}

/** 一行结果 → 协议里的 `OcrBlock`（`field2` 与在线版同口径：置信度 ×100 取整）。 */
function toBlock(line: OcrWorkerLine): OcrBlock {
  const confidence = line.text ? line.textScore : line.score;
  return {
    text: line.text,
    rect: line.rect as OcrRect,
    quad: line.quad,
    parag: JSON.stringify({ Parag: { ParagNo: line.paragNo } }),
    field2: Math.max(0, Math.min(100, Math.round(confidence * 100))),
  };
}

/**
 * 跑一次本地识别。**不抛错**：引擎崩了 / 模型坏了都从 `ok: false` 里说人话，
 * 让调用方（router）自己决定怎么回退。
 */
export function runOcrEngine(request: OcrEngineRequest): Promise<OcrEngineResult> {
  const started = Date.now();
  const { image, paths, mode = 'ocr' } = request;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: OcrEngineResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: string): OcrEngineResult => ({
      ok: false,
      blocks: [],
      imageWidth: image.width,
      imageHeight: image.height,
      elapsedMs: Date.now() - started,
      error,
    });

    let workerPath: string;
    try {
      workerPath = resolveWorkerPath();
    } catch (error) {
      done(fail(error instanceof Error ? error.message : String(error)));
      return;
    }

    let worker: ReturnType<typeof fork>;
    try {
      worker = fork(workerPath, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
      });
    } catch (error) {
      done(fail(`本地识别引擎启动失败：${String(error)}`));
      return;
    }

    worker.on('message', (msg: OcrWorkerMessage) => {
      if (msg?.type === 'final') {
        const lines = msg.lines ?? [];
        done({
          ok: true,
          blocks: lines.map(toBlock),
          imageWidth: image.width,
          imageHeight: image.height,
          elapsedMs: Date.now() - started,
        });
      } else if (msg?.type === 'error') {
        done(fail(msg.error ?? '本地识别失败'));
      }
      worker.disconnect();
      worker.kill();
    });

    worker.on('error', (error) => done(fail(String(error))));
    worker.on('exit', (code, signal) => {
      if (signal === 'SIGSEGV') {
        done(fail('本地识别引擎崩溃（底层推理库段错误）'));
        return;
      }
      done(
        code === 0
          ? fail('本地识别引擎没返回结果')
          : fail(`本地识别进程异常退出（code ${code ?? signal}）`),
      );
    });

    const params: OcrWorkerParams = {
      mode,
      width: image.width,
      height: image.height,
      data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      det: paths.det,
      rec: paths.rec,
      cls: paths.cls,
      dict: paths.dict,
      detOptions: request.detOptions,
      threads: request.threads,
    };
    worker.send(params);
  });
}
