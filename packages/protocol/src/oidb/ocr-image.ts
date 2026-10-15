// 0xe07_0 — 图片 OCR（QQ「图片文字识别」走的那条 OIDB）。
//
// 上行不传图片本体，只传**服务端 VOD 直链 + 校验信息**。内层 body 的字段是：
//   `1`       恒 1（任务类型；抓包只见过这一个取值）
//   `2` `3`   恒 0
//   `10.1`    图片地址，形如
//             `https://qqpicocr-<n>.njc.vod.tencent-cloud.com/<uuid>?file_md5=<md5>`
//   `10.10` / `10.11` 同一个 md5 的**小写十六进制字符串**（重复塞两个字段）
//   `10.12` / `10.13` / `10.14` 字节数 / 宽 / 高
//   `10.15`   恒 0
// 注意别被整包解析结果带偏：命令字 0xE07 在 native 补的那层信封里（整包解出来看到的
// `1 = 3591 = 0xE07` 是**信封**字段），内层 body 的 `1` 是任务类型。
// 地址里的 `<uuid>` 本地无源（服务端 VOD 分配）—— 可以直接当常量复用：同一条 URL
// 连发两次，回包文本一致（只是 `10.3` 的 sessionId 每次不同）。
//
// 抓包的信封上还有一个 `6: "android 9.2.85"`（客户端平台串）。native 的
// `sendOidbPacket` 组包不带这个字段，实测服务端不校验它（去掉照样回 `succ`）。
// 重放也不需要签名（不带 SecSign 即可）。
//
// 下行（也是内层 body）：`2` 是状态串（成功 = `succ`），文本与坐标全在 `10`：
//   `10.1[].1`    识别出的文本
//   `10.1[].3.1`  文字框 —— 4 个角点，顺序为 左上 → 右上 → 右下 → 左下
//   `10.1[].5`    同一个框的 `{ x, y, width, height }`
//   `10.1[].4`    段落标记 JSON（`{"Parag":{"ParagNo":1}}`）
//   `10.1[].2`    未解：实测两段分别是 99 / 97，疑似识别置信度（未验证）
//   `10.111/112`  图片宽 / 高（回显上行的尺寸）
//   `10.101/102/103` 语种列表 / 默认语种 / 语种码→中文名对照
//
// 坐标系是**喂进去那张图的像素坐标**（原点左上，与 `10.111/112` 同系）。原尺寸送进去
// 时回包的框可以直接画在原图上 —— 实测 `5` 与图上文字的外接矩形几乎重合（偏差只有
// 贴边像素和 JPEG 边缘的几像素）。若送的是裁切 / 缩放过的图，用
// {@link scaleOcrRect} / {@link scaleOcrPoints} 把坐标映射回目标图。

import { decode, encode, message } from '../protobuf';
import { toInt } from './shared';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

/** 上行 `1` 的任务类型 —— 抓包里只有 1。 */
export const OCR_TASK_TYPE = 1;

/** 抓包信封上的客户端平台串；native 组包不带，实测服务端不校验。 */
export const OCR_CLIENT_TAG = 'android 9.2.85';

const MD5_HEX = /^[0-9a-f]{32}$/;

const OCR_IMAGE = message([
  { name: 'url', tag: 1, type: 'string' },
  { name: 'fileMd5', tag: 10, type: 'string' },
  { name: 'fileMd5Dup', tag: 11, type: 'string' },
  { name: 'fileSize', tag: 12, type: 'uint32' },
  { name: 'width', tag: 13, type: 'uint32' },
  { name: 'height', tag: 14, type: 'uint32' },
  { name: 'field15', tag: 15, type: 'uint32', force: true },
]);

const OCR_REQ = message([
  { name: 'taskType', tag: 1, type: 'uint32', force: true },
  { name: 'field2', tag: 2, type: 'uint32', force: true },
  { name: 'field3', tag: 3, type: 'uint32', force: true },
  { name: 'image', tag: 10, type: OCR_IMAGE },
]);

const OCR_POINT = message([
  { name: 'x', tag: 1, type: 'uint32' },
  { name: 'y', tag: 2, type: 'uint32' },
]);

const OCR_QUAD = message([{ name: 'points', tag: 1, type: OCR_POINT, repeated: true }]);

const OCR_BBOX = message([
  { name: 'x', tag: 1, type: 'uint32' },
  { name: 'y', tag: 2, type: 'uint32' },
  { name: 'width', tag: 3, type: 'uint32' },
  { name: 'height', tag: 4, type: 'uint32' },
]);

const OCR_BLOCK = message([
  { name: 'text', tag: 1, type: 'string' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'quad', tag: 3, type: OCR_QUAD },
  { name: 'parag', tag: 4, type: 'string' },
  { name: 'bbox', tag: 5, type: OCR_BBOX },
]);

const OCR_LANG_NAME = message([
  { name: 'code', tag: 1, type: 'string' },
  { name: 'name', tag: 2, type: 'string' },
]);

const OCR_RESULT = message([
  { name: 'blocks', tag: 1, type: OCR_BLOCK, repeated: true },
  { name: 'srcLang', tag: 2, type: 'string' },
  { name: 'sessionId', tag: 3, type: 'string' },
  { name: 'langs', tag: 101, type: 'string', repeated: true },
  { name: 'defaultLang', tag: 102, type: 'string' },
  { name: 'langNames', tag: 103, type: OCR_LANG_NAME, repeated: true },
  { name: 'imageWidth', tag: 111, type: 'uint32' },
  { name: 'imageHeight', tag: 112, type: 'uint32' },
]);

const OCR_RESP = message([
  { name: 'status', tag: 2, type: 'string' },
  { name: 'result', tag: 10, type: OCR_RESULT },
]);

// ─────────────────────────── 结果类型 ───────────────────────────

export interface OcrPoint {
  x: number;
  y: number;
}

export interface OcrRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一段识别出来的文字 + 它的框。 */
export interface OcrBlock {
  text: string;
  /** 文字框（像素坐标，原点左上；坐标系同 {@link OcrResult.imageWidth}）。 */
  rect: OcrRect;
  /** 文字框的 4 个角点：左上 → 右上 → 右下 → 左下。 */
  quad: OcrPoint[];
  /** 段落标记，形如 `{"Parag":{"ParagNo":1}}`。 */
  parag: string;
  /** 未解：实测两段分别 99 / 97，疑似识别置信度。 */
  field2: number;
}

export interface OcrLanguage {
  code: string;
  name: string;
}

export interface OcrResult {
  /** 回包状态串，成功为 `succ`。 */
  status: string;
  blocks: OcrBlock[];
  /** 识别出的源语种（如 `en`）。 */
  srcLang: string;
  /** 本次任务的会话 id（同一包内每次不同）。 */
  sessionId: string;
  /** 可用语种码列表。 */
  langs: string[];
  /** 默认语种。 */
  defaultLang: string;
  /** 语种码 → 中文名对照表。 */
  langNames: OcrLanguage[];
  /** 被识别图片的宽（= 上行 `4.10.13`，也是回包坐标系的宽）。 */
  imageWidth: number;
  /** 被识别图片的高（= 上行 `4.10.14`）。 */
  imageHeight: number;
}

// ─────────────────────────── 坐标工具 ───────────────────────────

/** 4 个角点 → 外接矩形。回包里 `3.1` 与 `5` 本来就是同一个框，这里给个兜底。 */
export function quadToRect(points: readonly OcrPoint[]): OcrRect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** 外接矩形 → 4 个角点（左上 → 右上 → 右下 → 左下），补 `3.1` 缺失的情况。 */
export function rectToQuad(rect: OcrRect): OcrPoint[] {
  const { x, y, width, height } = rect;
  const right = x + width;
  const bottom = y + height;
  return [
    { x, y },
    { x: right, y },
    { x: right, y: bottom },
    { x, y: bottom },
  ];
}

/**
 * 把「在小图 / 裁切图上 OCR」得到的框映射回目标尺寸。
 * scaleX = 目标宽 / 喂进去的图宽（裁切时还要自己补加裁切偏移）。
 */
export function scaleOcrRect(rect: OcrRect, scaleX: number, scaleY: number): OcrRect {
  return {
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleY),
  };
}

/** {@link scaleOcrRect} 的角点版。 */
export function scaleOcrPoints(
  points: readonly OcrPoint[],
  scaleX: number,
  scaleY: number,
): OcrPoint[] {
  return points.map((p) => ({ x: Math.round(p.x * scaleX), y: Math.round(p.y * scaleY) }));
}

// ─────────────────────────── 反序列化 ───────────────────────────

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

function readBlock(raw: unknown): OcrBlock {
  const b = asRecord(raw);
  const quad = asArray(asRecord(b.quad).points).map((p) => {
    const pt = asRecord(p);
    return { x: toInt(pt.x), y: toInt(pt.y) };
  });
  const rawRect = asRecord(b.bbox);
  const rect: OcrRect = {
    x: toInt(rawRect.x),
    y: toInt(rawRect.y),
    width: toInt(rawRect.width),
    height: toInt(rawRect.height),
  };
  const hasRect = rect.width > 0 || rect.height > 0;
  const finalRect = hasRect ? rect : quadToRect(quad);
  return {
    text: asString(b.text),
    rect: finalRect,
    quad: quad.length > 0 ? quad : rectToQuad(finalRect),
    parag: asString(b.parag),
    field2: toInt(b.field2),
  };
}

function deserializeResult(body: Record<string, unknown>): OcrResult {
  const result = asRecord(body.result);
  return {
    status: asString(body.status),
    blocks: asArray(result.blocks).map(readBlock),
    srcLang: asString(result.srcLang),
    sessionId: asString(result.sessionId),
    langs: asArray(result.langs).map(asString),
    defaultLang: asString(result.defaultLang),
    langNames: asArray(result.langNames).map((raw) => {
      const l = asRecord(raw);
      return { code: asString(l.code), name: asString(l.name) };
    }),
    imageWidth: toInt(result.imageWidth),
    imageHeight: toInt(result.imageHeight),
  };
}

// ─────────────────────────── spec ───────────────────────────

export namespace OcrImage {
  export const command = 0xe07;
  export const subCommand = 0;
  /** 实测重放不带 SecSign 也能拿结果。 */
  export const needSign = false;
  export const reqSchema = OCR_REQ;
  export const respSchema = OCR_RESP;

  export interface Params {
    /** 服务端 VOD 直链（路径 UUID 可当常量复用）。 */
    url: string;
    /** 图片文件 md5，32 位十六进制（大小写都收，上行统一小写）。 */
    fileMd5: string;
    /** 文件字节数，上行 `4.10.12`。 */
    fileSize?: number;
    /** 图片宽，上行 `4.10.13`；回包坐标就以它为基准。 */
    width?: number;
    /** 图片高，上行 `4.10.14`。 */
    height?: number;
    /** 覆盖上行 `1` 的任务类型，缺省 = {@link OCR_TASK_TYPE}。 */
    taskType?: number;
  }

  export const serialize = (p: Params): Record<string, unknown> => {
    const md5 = p.fileMd5.trim().toLowerCase();
    if (!MD5_HEX.test(md5)) {
      throw new Error(`图片 OCR 需要 32 位十六进制的 md5，收到「${p.fileMd5}」`);
    }
    if (!p.url) throw new Error('图片 OCR 缺少图片地址（url）');
    return {
      taskType: p.taskType ?? OCR_TASK_TYPE,
      field2: 0,
      field3: 0,
      image: {
        url: p.url,
        fileMd5: md5,
        fileMd5Dup: md5,
        fileSize: p.fileSize ?? 0,
        width: p.width ?? 0,
        height: p.height ?? 0,
        field15: 0,
      },
    };
  };

  export const deserialize = (body: Record<string, unknown>): OcrResult => deserializeResult(body);

  /** 只组包不发（重放 / 离线测试用）—— 得到的是**内层 body**，信封由 native 补。 */
  export const encodeRequest = (params: Params): Uint8Array => encode(OCR_REQ, serialize(params));

  /** 把下行内层 body 字节直接解成结果。 */
  export const decodeResponse = (bytes: Uint8Array): OcrResult =>
    deserializeResult(decode(OCR_RESP, bytes));

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<OcrResult> =>
    invokeOidb(nt, pid, OcrImage as OidbSpec<Params, OcrResult>, params);
}
