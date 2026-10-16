/**
 * OcrModelService — 本地图片文字识别（OCR）的**模型管理**（注册表 + 下载 / 状态 /
 * 路径 / 删除）。
 *
 * 注册表里有两种用途（见 {@link OcrModelKind}）：
 *
 *   - `ocr`    **识别模型**：PP-OCR 的「文字检测 + 方向分类 + 识别」，产出逐行文字
 *              **和每行文字在原图上的像素坐标框**（与在线 OIDB 那条线同口径）；
 *   - `filter` **筛图模型**：只回答「这张图里有没有文字？」，用在批量 OCR（例如导出
 *              时自动识别）之前，把风景 / 人像这类没有文字的图先筛掉。判据就是
 *              PP-OCR 的检测网络本身 —— 输出为空 = 没有文字，所以单独下一份最省的
 *              检测模型即可（1.7 MB，比识别模型小一个数量级）。
 *
 * 下载与落盘的通用机制在 `common/model_store.ts`（和语音模型共用同一套）。
 * **零原生**：这里只把 ONNX 文件摆到磁盘上，真正跑推理的引擎（onnxruntime）留给
 * app 侧，和语音「模型管理在 service、引擎在 app」是同一个分工。
 *
 * 模型落在 `<appDataRoot>/models/<id>/`（与语音模型同一个根，靠 id 前缀区分）。
 * 来源：ModelScope 的 `RapidAI/RapidOCR`（PaddleOCR 官方 PP-OCR 模型的 ONNX 版，
 * 与 PaddleOCR 官方发布同源）。体积按上游仓库的真实字节数写进注册表。
 *
 * 这一层**零原生**：真正跑推理的 worker（onnxruntime + PP-OCR 后处理）在 app 侧
 * （`apps/desktop/src/main/ocr/`），哪些机器跑得起来见 {@link localOcrBlocker}。
 */

import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import {
  ModelStore,
  type ModelDiskState,
  type ModelDownloadProgress,
  type ModelEntry,
  type ModelFile,
} from './model_store';

/** 模型用途：识别（出文字）还是筛图（只判断有没有文字）。 */
export type OcrModelKind = 'ocr' | 'filter';

/** 一个模型文件在上游仓库里的位置与体积。 */
interface OcrFileSpec {
  /** 文件在模型里的角色，也是 {@link ModelStore.resolveModelPaths} 的 key。 */
  key: 'det' | 'rec' | 'cls' | 'dict';
  /** 落盘后的文件名（沿用上游名字，方便和源头对账）。 */
  name: string;
  /** 上游仓库里的相对路径（拼在 {@link RAPIDOCR_ROOT} 后面）。 */
  path: string;
  /** 上游文件字节数（用来算下载权重，也用来算总体积）。 */
  bytes: number;
}

/** A downloadable OCR model the user can pick in settings. */
export interface OcrModelInfo extends ModelEntry {
  /** Stable id, also the on-disk directory name and the config value. */
  id: string;
  /** What this model is for. */
  kind: OcrModelKind;
  /** Inference engine family — drives the (future) app-side worker config. */
  engine: 'ppocr';
  /** 上游档位标识（如 `PP-OCRv5 mobile`），给引擎侧选预处理参数用的。 */
  variant: string;
  /** Display name. */
  name: string;
  /** One-line description (what it recognizes / how heavy it is). */
  desc: string;
  /** Total download size in bytes. */
  sizeBytes: number;
  /** Human label for the size (e.g. "21.5 MB"). */
  sizeLabel: string;
  /** 能识别的语种（筛图模型为空 —— 它不识别文字）。 */
  languages: string[];
  /** Whether this is the recommended default for its kind. */
  recommended: boolean;
  /** Files that make up the model. */
  files: ModelFile[];
}

/** A model entry enriched with its on-disk / in-flight state. */
export type OcrModelStatus = OcrModelInfo & ModelDiskState;

/** Progress payload emitted during a download. */
export type OcrDownloadProgress = ModelDownloadProgress;

/** 上游仓库：RapidOCR 托管的 PP-OCR ONNX 模型（ModelScope）。 */
const RAPIDOCR_ROOT = 'https://modelscope.cn/models/RapidAI/RapidOCR/resolve/master';

/** 按字节数算每个文件的下载权重（和为 1），避免手写小数在改体积后漂移。 */
function buildFiles(specs: readonly OcrFileSpec[]): ModelFile[] {
  const total = specs.reduce((sum, s) => sum + s.bytes, 0);
  return specs.map((s) => ({
    key: s.key,
    name: s.name,
    url: `${RAPIDOCR_ROOT}/${s.path}`,
    weight: total > 0 ? s.bytes / total : 0,
  }));
}

/** 注册表里所有文件的总字节数 —— 和 UI 显示的「约 X MB」是同一个数。 */
function totalBytes(specs: readonly OcrFileSpec[]): number {
  return specs.reduce((sum, s) => sum + s.bytes, 0);
}

/** 字节 → "21.5 MB"。 */
function sizeLabel(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * PP-OCRv5 移动版：检测 + 方向分类 + 识别 + 字典。
 * 中文（简 / 繁）为主，带英文 / 日文；四件套合计约 21.5 MB。
 */
const PPOCR_V5_MOBILE: readonly OcrFileSpec[] = [
  {
    key: 'det',
    name: 'ch_PP-OCRv5_det_mobile.onnx',
    path: 'onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx',
    bytes: 4_819_576,
  },
  {
    key: 'rec',
    name: 'ch_PP-OCRv5_rec_mobile.onnx',
    path: 'onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx',
    bytes: 16_631_306,
  },
  {
    key: 'cls',
    name: 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx',
    path: 'onnx/PP-OCRv5/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx',
    bytes: 1_018_508,
  },
  {
    key: 'dict',
    name: 'ppocrv5_dict.txt',
    path: 'paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt',
    bytes: 74_012,
  },
];

/**
 * PP-OCRv6 检测（tiny）：**只做检测**，1.74 MB —— 全家族里最省的"有没有文字"
 * 判据。给筛图用，不需要字典，也不出文字。
 */
const PPOCR_V6_DET_TINY: readonly OcrFileSpec[] = [
  {
    key: 'det',
    name: 'PP-OCRv6_det_tiny.onnx',
    path: 'onnx/PP-OCRv6/det/PP-OCRv6_det_tiny.onnx',
    bytes: 1_829_618,
  },
];

/**
 * The model registry. 加模型是**纯注册表改动** —— UI 逐条渲染这个列表，(未来的)
 * 引擎按 `engine` + 文件 key 决定怎么跑。
 */
export const OCR_MODELS: OcrModelInfo[] = [
  {
    id: 'ppocr-v5-mobile',
    kind: 'ocr',
    engine: 'ppocr',
    variant: 'PP-OCRv5 mobile',
    name: 'PP-OCRv5 移动版',
    desc: '中文（简 / 繁）/ 英文 / 日文；检测 + 方向分类 + 识别，出逐行文字与像素坐标框',
    sizeBytes: totalBytes(PPOCR_V5_MOBILE),
    sizeLabel: sizeLabel(totalBytes(PPOCR_V5_MOBILE)),
    languages: ['zh', 'zh-Hant', 'en', 'ja'],
    recommended: true,
    files: buildFiles(PPOCR_V5_MOBILE),
  },
  {
    id: 'ppocr-v6-det-tiny',
    kind: 'filter',
    engine: 'ppocr',
    variant: 'PP-OCRv6 det tiny',
    name: 'PP-OCRv6 检测（tiny）',
    desc: '只判断「图里有没有文字」，用来快速筛掉风景 / 人像等没有文字的图；最省，不出文字',
    sizeBytes: totalBytes(PPOCR_V6_DET_TINY),
    sizeLabel: sizeLabel(totalBytes(PPOCR_V6_DET_TINY)),
    languages: [],
    recommended: true,
    files: buildFiles(PPOCR_V6_DET_TINY),
  },
];

/** Look up a model in the registry by id. */
export function getOcrModel(id: string): OcrModelInfo | undefined {
  return OCR_MODELS.find((m) => m.id === id);
}

/**
 * onnxruntime-node 真正发布过的 CPU 二进制矩阵（包内 `bin/napi-v6/<platform>/<arch>/`）。
 *
 * 为什么要把这份清单写进代码：`onnxruntime-node/dist/binding.js` 是按
 * `process.platform` + `process.arch` **硬拼路径** require 的
 * （`require(\`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node\`)`），
 * 包里没有那个目录就是必然的 MODULE_NOT_FOUND —— 不是「模型没下好」，是引擎根本不在这台机器上。
 *
 * 上游从 1.2x 起就不发 macOS Intel（darwin/x64）了，于是 Intel Mac 上本地识别**没有
 * 引擎可跑**。这份清单是两处的共同事实源：
 *
 *   - 打包时留哪份二进制：`apps/desktop/electron-builder.yml` 的 win / mac / linux 段
 *     （按 `${arch}` 挑 `bin/napi-v6/<platform>/${arch}/**`）；
 *   - 这台机器能不能跑本地识别：{@link localOcrBlocker}。
 *
 * 改这里（升级 onnxruntime 版本）时两边一起看。
 */
export const ONNXRUNTIME_CPU_TARGETS: readonly string[] = [
  'win32/x64',
  'win32/arm64',
  'linux/x64',
  'linux/arm64',
  'darwin/arm64',
];

/** 平台名 → 用户认得出的名字（错误提示里用）。 */
const PLATFORM_LABELS: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

/** `darwin` + `x64` → `macOS Intel`，让用户直接对上自己那台机器。 */
function targetLabel(platform: string, arch: string): string {
  const name = PLATFORM_LABELS[platform] ?? platform;
  if (arch === 'x64') return `${name} Intel`;
  if (arch === 'arm64') return `${name} ARM`;
  return `${name} ${arch}`;
}

/**
 * 这台机器能不能跑本地识别引擎：能跑返回 null，跑不了返回**给人看的原因**。
 *
 * 口径与 `apps/desktop/src/main/ocr/local.ts` 的可用性判定一致（那里拿它当前置闸，
 * 于是灯箱 / 导出 / MCP 三处都会走「本地那条腿不可用」的分支），也与打包时实际留下的
 * 二进制一致。典型场景就是 macOS Intel：模型下好了也加载不了，别让用户白下 21 MB。
 */
export function localOcrBlocker(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const target = `${platform}/${arch}`;
  if (ONNXRUNTIME_CPU_TARGETS.includes(target)) return null;
  return (
    `当前平台（${targetLabel(platform, arch)}）没有本地识别引擎：onnxruntime 没发布 ` +
    `${target} 的二进制，本地模型在这台机器上跑不起来（在线识别不受影响）。`
  );
}

export class OcrModelService extends ModelStore<OcrModelInfo> {
  constructor(platform: Platform) {
    super(join(platform.appDataRoot(), 'models'), OCR_MODELS);
  }

  /** 某一类（识别 / 筛图）的模型，附落盘与下载状态。 */
  listByKind(kind: OcrModelKind): OcrModelStatus[] {
    return this.listModels().filter((m) => m.kind === kind);
  }
}
