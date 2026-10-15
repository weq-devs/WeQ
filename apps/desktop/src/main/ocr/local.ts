/**
 * 本地 OCR —— 灯箱那条「在线不行就本地」的回退腿落地在这里：
 * 可用性判定（模型下好了没）+ 取图（把灯箱里那张图的原图字节捞出来）+ 跑引擎。
 *
 * 取图这一步分两种：`data:` URL 与本机文件路径（MCP 工具、导出目录这类手上就是路径的
 * 调用方）直接读字节；`weq-media://` 的**复用媒体协议那一整套解析链**
 * （`media_protocol.handleMediaRequest`）—— 渲染层把灯箱正在显示的 `src`
 * （`weq-media://pic?…`）原样递进来，这里等价于主进程自己发一次同一个「虚拟请求」，
 * 于是本地落盘 → chatpic 备份 → CDN → OIDB 补下 的优先级、以及 `localfile` /
 * `localmedia` 那些分支全都白拿，不用再写第二份。
 *
 * 代价要说清楚：本地识别只解决「像素 → 文字」，**图本身还是得取得到**（本机 QQ
 * 落过盘，或者 rkey / 直链还活着）。取不到就如实报错，不假装能离线识别一切。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrBlock } from '@weq/protocol';
import { getOcrModel, type OcrFilterOutcome, type OcrImageOutcome } from '@weq/service';
import { getAppContext } from '../context/app_context';
import { handleMediaRequest } from '../media_protocol';
import { runOcrEngine, type OcrEnginePaths } from './engine';
import { judgeTextBoxes } from './filter';
import { decodeImageBytes, decodeImageDataUrl } from './image';
// 只引类型：管线本体由 worker 独享（带上运行时会让 rollup 多抽一个共享 chunk，
// 见 `engine.ts` 顶部那段说明）。
import type { RgbImage } from './pipeline';

/** 一个「已选且已下载」的本地识别模型。 */
export interface LocalOcrModel {
  modelId: string;
  paths: OcrEnginePaths;
}

/**
 * 当前可用的本地识别模型：设置里选了 + 文件都下好了，才算数；否则返回 null
 * （前端据此决定 OCR 按钮能不能点）。
 */
export function resolveLocalOcrModel(): LocalOcrModel | null {
  const boot = getAppContext().bootstrap;
  if (!boot) return null;
  const modelId = boot.userConfig.getSettings().ocr.modelId;
  if (!modelId) return null;
  const model = getOcrModel(modelId);
  // 筛图模型不出文字，不能拿来当识别模型用。
  if (model?.kind !== 'ocr') return null;
  if (!boot.ocrModels.getModelStatus(modelId)?.downloaded) return null;
  const paths = boot.ocrModels.resolveModelPaths(modelId);
  const det = paths.det;
  const rec = paths.rec;
  const dict = paths.dict;
  if (!det || !rec || !dict) return null;
  return { modelId, paths: { det, rec, cls: paths.cls, dict } };
}

export interface LocalOcrOutcome {
  blocks: OcrBlock[];
  imageWidth: number;
  imageHeight: number;
  elapsedMs: number;
  modelId: string;
}

/** 一个「已选且已下载」的本地筛图模型（只出「有没有文字」，不出文字）。 */
export interface LocalOcrFilterModel {
  modelId: string;
  /** 检测模型文件的绝对路径。 */
  det: string;
}

/**
 * 当前可用的本地筛图模型：设置里选了 + 模型下好了才算数，否则返回 null。
 * 筛图只要检测网络，所以注册表里那份 1.7 MB 的 tiny 检测模型就够。
 */
export function resolveLocalOcrFilterModel(): LocalOcrFilterModel | null {
  const boot = getAppContext().bootstrap;
  if (!boot) return null;
  const modelId = boot.userConfig.getSettings().ocr.filterModelId;
  if (!modelId) return null;
  const model = getOcrModel(modelId);
  // 识别模型不能拿来筛图（它要 rec / dict，这里只给 det）。
  if (model?.kind !== 'filter') return null;
  if (!boot.ocrModels.getModelStatus(modelId)?.downloaded) return null;
  const det = boot.ocrModels.resolveModelPaths(modelId).det;
  if (!det) return null;
  return { modelId, det };
}

/**
 * 把「一张图的地址」认成本机文件路径，认不出返回 null。
 *
 * 覆盖三种写法：`file://` URL、`~/` 开头、以及平台绝对路径（Windows 的 `C:\…` 也认）。
 * 相对路径**故意不认** —— 主进程的 cwd 不是调用者想当然的那个目录，静默按 cwd 解析
 * 会读到一个「恰好同名」的错文件，不如让调用方自己补全。
 */
function localPathOf(src: string): string | null {
  if (src.startsWith('file://')) {
    try {
      return fileURLToPath(src);
    } catch {
      return null;
    }
  }
  if (src.startsWith('~/')) return join(homedir(), src.slice(2));
  return isAbsolute(src) ? src : null;
}

/** 灯箱里那张图的字节：`data:` / 本机路径 / `weq-media://` / `http(s)://` 四条来源。 */
async function readImageSource(src: string): Promise<Buffer> {
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    const header = src.slice(0, comma);
    const body = src.slice(comma + 1);
    return Buffer.from(body, header.includes(';base64') ? 'base64' : 'utf8');
  }
  // 本机文件：MCP 工具、导出目录这类「手上就是路径」的调用方走这条 —— 直接读盘，不出网。
  const localPath = localPathOf(src);
  if (localPath) {
    try {
      return await readFile(localPath);
    } catch (error) {
      throw new Error(
        `读不到这个本机文件（${localPath}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (src.startsWith('weq-media://')) {
    const response = await handleMediaRequest(new Request(src));
    if (!response.ok) {
      throw new Error(
        '本机没有这张图的文件，本地模型也就没法识别（可以在线识别 / 换张近期的图）。',
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
  if (/^https?:\/\//.test(src)) {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`下载图片失败（HTTP ${response.status}）`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('这张图的地址取不到本体，本地模型识别不了。');
}

/** 裸 RGB → 本地模型 → 与在线版同构的结果（识别不出文字的行丢掉）。 */
async function recognizeImage(image: RgbImage, model: LocalOcrModel): Promise<LocalOcrOutcome> {
  const result = await runOcrEngine({ image, paths: model.paths, mode: 'ocr' });
  if (!result.ok) throw new Error(result.error ?? '本地识别失败');
  return {
    // 识别不出文字的行直接丢掉：灯箱里画一堆空框没有任何意义。
    blocks: result.blocks.filter((block) => block.text.trim() !== ''),
    imageWidth: result.imageWidth,
    imageHeight: result.imageHeight,
    elapsedMs: result.elapsedMs,
    modelId: model.modelId,
  };
}

/**
 * 用本地模型识别一张图。抛错 = 这次没成（错误消息是给人看的中文短句）。
 *
 * `src` 是那张图的地址，四条来源：`data:` URL（剪贴板截图）、本机文件路径
 * （MCP 工具 / 导出目录）、`weq-media://`（渲染层灯箱正在显示的图）、`http(s)://`。
 */
export async function runLocalOcr(src: string, model: LocalOcrModel): Promise<LocalOcrOutcome> {
  const bytes = await readImageSource(src);
  const image = src.startsWith('data:') ? decodeImageDataUrl(src) : decodeImageBytes(bytes);
  if (!image) throw new Error('这张图的格式解不开，本地模型识别不了。');
  return recognizeImage(image, model);
}

// ── 导出阶段（批量）用的两个入口 ─────────────────────────────────────────────
// 都是「一张图进、一份结果出」，并发 / 顺序 / 回退由 @weq/service 的导出阶段控制。
// 每次调用自己解析一次当前选用的模型，用户中途换了设置立刻生效。

/**
 * 本地识别一张图（导出阶段注入 `OcrImageFn`）。**不抛错**：模型没配好、图读不到、
 * 引擎崩了都从 `ok: false` 里说人话，让导出阶段决定要不要记账。
 */
export async function runLocalOcrFile(imagePath: string): Promise<OcrImageOutcome> {
  const model = resolveLocalOcrModel();
  if (!model) return { ok: false, error: '没有可用的本地识别模型（设置 → 图片识别）' };
  try {
    const r = await runLocalOcr(imagePath, model);
    return {
      ok: true,
      text: r.blocks.map((b) => b.text).join('\n'),
      blocks: r.blocks,
      width: r.imageWidth,
      height: r.imageHeight,
      elapsedMs: r.elapsedMs,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 筛图：只跑检测网络，回答「这张图里有没有文字」（导出阶段注入 `OcrFilterFn`）。
 *
 * 判据本体（含丢掉「整图大小的框」那一步）在纯函数 {@link judgeTextBoxes} 里，见那里的
 * 说明 —— 实测 tiny 模型在正方形小图上会把整张图判成一个文字块，那是误报。
 */
export async function runLocalOcrFilterFile(imagePath: string): Promise<OcrFilterOutcome> {
  const model = resolveLocalOcrFilterModel();
  if (!model) {
    return { ok: false, error: '未下载筛图模型', unavailable: true };
  }
  try {
    const bytes = await readFile(imagePath);
    const image = decodeImageBytes(bytes);
    if (!image) return { ok: false, error: '这张图的格式解不开' };
    // 筛图一次并发好几个进程，每个少开点线程（见 engine 的 threads）。
    const r = await runOcrEngine({
      image,
      paths: { det: model.det },
      mode: 'detect',
      threads: 2,
    });
    if (!r.ok) return { ok: false, error: r.error ?? '筛图失败' };
    const decision = judgeTextBoxes(r.blocks, r.imageWidth, r.imageHeight);
    return {
      ok: true,
      hasText: decision.hasText,
      boxes: decision.boxes,
      elapsedMs: r.elapsedMs,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
