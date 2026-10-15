/**
 * 本地 OCR worker —— 在 **forked 子进程**里跑 onnxruntime。
 *
 * 为什么要子进程：onnxruntime 是原生库（一个巨大的 C++ 运行时 + 每张图几秒的 CPU
 * 推理），推理崩了 / 卡了只该死这一张图，不能带崩 Electron 主进程。这套隔离照
 * `transcribe/worker.ts`（语音那条线）抄：主进程 `fork` 本文件 → 发一次参数 → 等
 * 一条 `final` / `error` → 收工。
 *
 * 由 electron-vite 单独打成一个入口 `out/main/ocrWorker.mjs`，`onnxruntime-node`
 * 留成 external 从 node_modules 里 require（打包时 asarUnpack，见 electron-builder.yml）。
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import {
  assignParagraphs,
  parseDict,
  runOcrPipeline,
  type DetOptions,
  type OcrSession,
  type TextLine,
} from './pipeline';

const requireFn = createRequire(__filename);

export interface OcrWorkerParams {
  /** `ocr` = 出文字；`detect` = 只要框（筛图模式，不加载识别模型）。 */
  mode: 'ocr' | 'detect';
  /** 图片尺寸（`data` 是裸 RGB，每像素 3 字节）。 */
  width: number;
  height: number;
  data: Buffer | Uint8Array | { type: 'Buffer'; data: number[] };
  /** 模型文件绝对路径（`det` 必给）。 */
  det: string;
  rec?: string;
  cls?: string;
  /** 识别字典（`ppocrv5_dict.txt`）。 */
  dict?: string;
  detOptions?: Partial<DetOptions>;
  /** 推理线程数（缺省见 {@link defaultThreads}）。 */
  threads?: number;
}

export type OcrWorkerMessage =
  | { type: 'final'; lines: OcrWorkerLine[] }
  | { type: 'error'; error: string };

/** 一行结果 + 段落号（1 起）。段落分组要按整段阅读顺序算，所以在管线跑完的地方做完。 */
export interface OcrWorkerLine extends TextLine {
  paragNo: number;
}

/**
 * 推理线程数：实测 8 线程是甜点（16 核机器上 8 → 2.4-3.4s，用默认值要 6s+，
 * 再往上加反而变慢：线程争抢）。
 */
function defaultThreads(): number {
  const cores = availableParallelism?.() ?? 4;
  return Math.max(1, Math.min(8, cores));
}

/** onnxruntime 会话的最小形状（只用到输入输出名 + run）。 */
interface OrtSessionLike {
  inputNames: string[];
  outputNames: string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
}

/** onnxruntime 运行时（只在真正 `require` 之后存在）。 */
interface OrtLike {
  InferenceSession: {
    create(path: string, options: Record<string, unknown>): Promise<OrtSessionLike>;
  };
  Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown;
}

function normalizeBuffer(data: OcrWorkerParams['data']): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)) {
    return Buffer.from((data as { data: number[] }).data);
  }
  return Buffer.alloc(0);
}

async function run(params: OcrWorkerParams): Promise<void> {
  const emit = (msg: OcrWorkerMessage): void => {
    if (typeof process.send !== 'function') return;
    // 等 IPC 真正冲出去再退，别让父进程收不到这条最终消息。
    const code = msg.type === 'final' ? 0 : 1;
    process.send(msg, () => process.exit(code));
    // 兜底：IPC 回调没来（管道断了之类）也别把进程吊着。
    setTimeout(() => process.exit(code), 3000).unref();
  };
  try {
    const ort = requireFn('onnxruntime-node') as OrtLike;
    const sessionOptions = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: params.threads ?? defaultThreads(),
    };

    const wrap = async (path: string): Promise<OcrSession> => {
      const session = await ort.InferenceSession.create(path, sessionOptions);
      const input = session.inputNames[0];
      const output = session.outputNames[0];
      if (!input || !output) throw new Error(`模型 ${path} 没有可用的输入 / 输出`);
      return {
        async run(data, dims) {
          const out = await session.run({
            [input]: new ort.Tensor('float32', data, dims),
          });
          const tensor = out[output];
          if (!tensor) throw new Error(`模型 ${path} 没吐结果`);
          return { data: tensor.data, dims: tensor.dims };
        },
      };
    };

    const wantText = params.mode === 'ocr';
    if (wantText && (!params.rec || !params.dict)) {
      throw new Error('识别模型文件不全（缺 rec / dict），请到「设置 → 图片识别」重新下载');
    }

    const image = {
      width: params.width,
      height: params.height,
      data: normalizeBuffer(params.data),
    };
    if (image.data.length < image.width * image.height * 3) {
      throw new Error('图片数据不完整，无法识别');
    }

    const det = await wrap(params.det);
    const cls = params.cls ? await wrap(params.cls) : undefined;
    const rec = wantText && params.rec ? await wrap(params.rec) : undefined;
    const dict = wantText && params.dict ? parseDict(readFileSync(params.dict, 'utf8')) : undefined;

    const lines = await runOcrPipeline(image, {
      det,
      cls,
      rec,
      dict,
      detOptions: params.detOptions,
    });
    const paragraphs = assignParagraphs(lines);
    emit({
      type: 'final',
      lines: lines.map((line, index) => ({ ...line, paragNo: paragraphs[index] ?? 1 })),
    });
  } catch (error) {
    emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
}

// 参数只到一次（父进程 `send`）。父进程断开就退出，别留孤儿进程。
let started = false;
process.once('message', (msg) => {
  if (started) return;
  started = true;
  void run(msg as OcrWorkerParams);
});
process.once('disconnect', () => process.exit(0));
