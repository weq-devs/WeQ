/**
 * 富媒体上传的**按类型入口** —— 图片 / 语音 / 视频。
 *
 * 三者的差别只在参数（OIDB 命令号、highway cmdId、fileInfo 的 type/尺寸字段、
 * extBizInfo 占位），流水线是同一条（`./ntv2-upload` 申请 + `./highway-client` PUT），
 * 所以这里只做「探测/哈希 → 组装 uploadInfo → 回写 msgInfo」，不重复编排逻辑。
 *
 * 返回值里的 `msgInfo` 就是 outgoing `commonElem { serviceType: 48,
 * businessType: 20/21/22 }.pbElem` 的字节（收侧 `../msg/decode` 解同一份结构）。
 *
 * 对照 SnowLuma `highway/image-upload.ts` / `ptt-upload.ts` / `video-upload.ts`。
 * 差异（有意为之，都写在注释里）：
 *   - **不引 ffmpeg**：视频封面由调用方给（或我们合成一张纯色 PNG）、时长由调用方给。
 *     SL 用 ffmpeg 抽封面/探时长，这里把这两项变成显式入参（拿不到就给兜底值）。
 *   - 波形：给 PCM/WAV → 真条；给不出 → `./ptt-waveform` 的合成条（不联网、不解码）。
 *   - SL 在 pic extBizInfo 里塞的 `reserveTroop` / `reserveC2c` 并不在它的 proto
 *     schema 里（编码时被丢掉），所以本包也不发 —— 与 SL 的实际线上字节一致。
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { computeHashes, readFileRange } from './hash-file';
import { HIGHWAY_BLOCK_SIZE } from './highway-client';
import { detectImageFormat, makeSolidPng, PIC_FORMAT_JPEG, PIC_FORMAT_PNG } from './image-format';
import {
  finalizeMediaMsgInfo,
  makeClientRandomId,
  type MediaNative,
  type MediaSubFileUpload,
  type Ntv2UploadInfoInput,
  runNtv2Upload,
} from './ntv2-upload';
import { buildPttWaveform, type PttWaveformSource } from './ptt-waveform';
import { Sha1Stream } from './sha1-stream';
import type { Ntv2UploadResp } from './ntv2-schemas';

// ───────────────────────── 常量 ─────────────────────────

/** NTV2 上传申请（0xE37_100）的命令号：群 / 私聊各一组。 */
export const IMAGE_OIDB_GROUP = 0x11c4;
export const IMAGE_OIDB_C2C = 0x11c5;
export const PTT_OIDB_GROUP = 0x126e;
export const PTT_OIDB_C2C = 0x126d;
export const VIDEO_OIDB_GROUP = 0x11ea;
export const VIDEO_OIDB_C2C = 0x11e9;

/** highway 命令号（进 `msgBaseHead.commandId`）。 */
export const IMAGE_HIGHWAY_GROUP = 1004;
export const IMAGE_HIGHWAY_C2C = 1003;
export const PTT_HIGHWAY_GROUP = 1008;
export const PTT_HIGHWAY_C2C = 1007;
export const VIDEO_HIGHWAY_GROUP = 1005;
export const VIDEO_HIGHWAY_C2C = 1001;
export const VIDEO_THUMB_HIGHWAY_GROUP = 1006;
export const VIDEO_THUMB_HIGHWAY_C2C = 1002;

/** `reqHead.scene.businessType`：1 图片 / 2 视频 / 3 语音。 */
export const MEDIA_BUSINESS_TYPE = { image: 1, video: 2, voice: 3 } as const;
/** 富媒体消息的 commonElem：serviceType=48，businessType 20/21/22。 */
export const RICH_MEDIA_SERVICE_TYPE = 48;
export const RICH_MEDIA_BUSINESS_TYPE = {
  image: 20,
  video: 21,
  /**
   * 语音：群 / 私聊都是 22。
   *
   * 曾试过按安卓抓包把私聊改成 12（`0x126d_100` + `PbSendMsg` 两条抓包里是 12），
   * 真机发出去后收端（QQ）**依然不画波形**，所以回滚 —— 私聊波形平不是这个值的问题。
   */
  voice: 22,
} as const;

/** 视频封面兜底尺寸（SL 内嵌的就是 720×1280）。 */
export const DEFAULT_VIDEO_THUMB_WIDTH = 720;
export const DEFAULT_VIDEO_THUMB_HEIGHT = 1280;

// ───────────────────────── 公共类型 ─────────────────────────

/** 媒体来源：本地文件路径，或已在内存里的字节。 */
export type MediaSource = string | Uint8Array;

/** 上传目标：自己 uin（highway 帧头）+ 会话（群号 / 对方 uid）。 */
export interface MediaUploadTarget {
  /** 自己账号的 uin —— highway 帧头要带。 */
  uin: string | number;
  /** 群聊传群号；私聊传对方 uid（NTV2 与 PbSendMsg 路由都要求 uid）。 */
  isGroup: boolean;
  groupId?: number;
  userUid?: string;
}

export interface MediaUploadOptions {
  log?: (message: string) => void;
}

/** 上传结果：`msgInfo` 直接进 outgoing commonElem.pbElem。 */
export interface MediaUploadResult {
  /** commonElem(serviceType=48).pbElem 字节。 */
  msgInfo: Uint8Array;
  /**
   * commonElem.businessType —— 由上传方给（目前群 / 私聊取值相同，但放在这里
   * 是为了将来某个类型真的要分场景时不用改元素层）。
   */
  businessType: number;
  /** 服务端命中 fast-upload（资源已在服务器上，没有真的传字节）。 */
  fastUpload: boolean;
  fileName: string;
  fileSize: number;
  md5Hex: string;
  sha1Hex: string;
  width: number;
  height: number;
}

async function readMediaSource(source: MediaSource, what: string): Promise<Uint8Array> {
  if (typeof source === 'string') {
    if (!source.trim()) throw new Error(`${what} 来源不能是空路径`);
    const bytes = new Uint8Array(await fsp.readFile(source));
    if (bytes.length === 0) throw new Error(`${what} 文件是空的: ${source}`);
    return bytes;
  }
  if (!(source instanceof Uint8Array)) throw new Error(`${what} 来源必须是文件路径或 Uint8Array`);
  if (source.length === 0) throw new Error(`${what} 字节是空的`);
  return source;
}

function resolveTargetId(target: MediaUploadTarget, what: string): string | number {
  if (target.isGroup) {
    if (!Number.isSafeInteger(target.groupId) || (target.groupId ?? 0) <= 0) {
      throw new Error(`${what} 群聊上传需要 groupId`);
    }
    return target.groupId as number;
  }
  if (!target.userUid?.trim()) throw new Error(`${what} 私聊上传需要 userUid（NTV2 只认 uid）`);
  return target.userUid;
}

const PIC_EXT_BY_FORMAT: Record<number, string> = {
  1000: '.jpg',
  1001: '.png',
  1002: '.webp',
  1005: '.bmp',
  2000: '.gif',
};

/** 服务端 fast-upload 命中判据：响应里没有 uKey 就说明字节不必传。 */
function isFastUpload(upload: Ntv2UploadResp): boolean {
  return !upload.uKey;
}

/** `upload` 段 → 统一结果（各类型共用）。 */
function toResult(
  upload: Ntv2UploadResp,
  msgInfo: Uint8Array,
  info: {
    businessType: number;
    fileName: string;
    fileSize: number;
    md5Hex: string;
    sha1Hex: string;
    width: number;
    height: number;
  },
): MediaUploadResult {
  return { msgInfo, fastUpload: isFastUpload(upload), ...info };
}

// ───────────────────────── 视频分块 sha1 ─────────────────────────

interface VideoHashes {
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  /** 每 1 MiB 块的 SHA1 中间态，最后一项是整文件 SHA1（highway 载荷要求）。 */
  sha1Blocks: Uint8Array[];
}

/**
 * 视频的 `hash.fileSha1` 数组：**每个完整的 1 MiB 块**各压一个中间态，最后补整文件
 * SHA1。
 *
 * 注意与 `./hash-file` 的 `hashFlashFileStreaming().sha1StateV` 的差别：闪传那套
 * 故意跳过最后一块的中间态（末尾是 sha1StateV 语义），而 highway 要「每块一条」，
 * 文件大小正好是 1 MiB 整数倍时两者长度不同，所以这里单算一遍（单 pass，不缓冲整文件）。
 */
async function hashVideoFile(filePath: string, size: number): Promise<VideoHashes> {
  const md5 = createHash('md5');
  const sha1 = createHash('sha1');
  const stream = new Sha1Stream();
  const sha1Blocks: Uint8Array[] = [];

  let offset = 0;
  while (offset < size) {
    const len = Math.min(HIGHWAY_BLOCK_SIZE, size - offset);
    const chunk = await readFileRange(filePath, offset, len);
    md5.update(Buffer.from(chunk));
    sha1.update(Buffer.from(chunk));
    stream.update(chunk);
    offset += len;
    if (offset % HIGHWAY_BLOCK_SIZE === 0) sha1Blocks.push(stream.hash(true));
  }

  const md5Digest = md5.digest();
  const sha1Digest = sha1.digest();
  sha1Blocks.push(new Uint8Array(sha1Digest));
  return {
    md5: new Uint8Array(md5Digest),
    sha1: new Uint8Array(sha1Digest),
    md5Hex: md5Digest.toString('hex'),
    sha1Hex: sha1Digest.toString('hex'),
    sha1Blocks,
  };
}

/** 内存字节版（小视频 / 测试用），与 {@link hashVideoFile} 同口径。 */
function hashVideoBytes(bytes: Uint8Array): VideoHashes {
  const hashes = computeHashes(bytes);
  const stream = new Sha1Stream();
  const sha1Blocks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const len = Math.min(HIGHWAY_BLOCK_SIZE, bytes.length - offset);
    stream.update(bytes.subarray(offset, offset + len));
    offset += len;
    if (offset % HIGHWAY_BLOCK_SIZE === 0) sha1Blocks.push(stream.hash(true));
  }
  sha1Blocks.push(hashes.sha1);
  return { ...hashes, sha1Blocks };
}

// ───────────────────────── 图片 ─────────────────────────

export interface UploadImageParams {
  source: MediaSource;
  /** 收端显示的文件名；缺省 `<md5><探测到的扩展名>`。 */
  fileName?: string;
  /** 图片子类型：0 普通图 / 1 动画表情 …（服务端据此归类）。缺省 0。 */
  subType?: number;
  /** 收端摘要文字；缺省 `[图片]` / `[动画表情]`。 */
  summary?: string;
  /** 手动覆盖探测结果（给了就不重新读头）。 */
  width?: number;
  height?: number;
  picFormat?: number;
}

function extBizPlaceholders(isGroup: boolean) {
  // SL 在这里塞 pic.reserveTroop / pic.reserveC2c 以及一堆空 bytes 占位，
  // 但那些字段不在它的 proto schema 里（会被编码器丢掉），本包同样不发。
  void isGroup;
  return {
    video: { bytesPbReserve: new Uint8Array(0) },
    ptt: {
      bytesReserve: new Uint8Array(0),
      bytesPbReserve: new Uint8Array(0),
      bytesGeneralFlags: new Uint8Array(0),
    },
  };
}

/**
 * 上传一张图片，返回 outgoing commonElem.pbElem。
 *
 * `original: 1` 表示发原图（不压缩）—— QQ 端据此决定是否走原图通道。
 */
export async function uploadImageMsgInfo(
  nt: MediaNative,
  pid: number,
  target: MediaUploadTarget,
  params: UploadImageParams,
  options: MediaUploadOptions = {},
): Promise<MediaUploadResult> {
  const bytes = await readMediaSource(params.source, '图片');
  const detected = detectImageFormat(bytes);
  const picFormat = params.picFormat ?? (detected.width > 0 ? detected.format : PIC_FORMAT_JPEG);
  const width = params.width ?? detected.width;
  const height = params.height ?? detected.height;
  const subType = params.subType ?? 0;
  const summary = params.summary ?? (subType === 1 ? '[动画表情]' : '[图片]');
  const hashes = computeHashes(bytes);
  const fileName = params.fileName ?? `${hashes.md5Hex}${PIC_EXT_BY_FORMAT[picFormat] ?? '.jpg'}`;

  const uploads: MediaSubFileUpload[] = [
    {
      source: 'top',
      cmdId: target.isGroup ? IMAGE_HIGHWAY_GROUP : IMAGE_HIGHWAY_C2C,
      bytes,
      md5: hashes.md5,
      sha1: hashes.sha1,
      fastOnlyError: '图片免字节上传不可用（服务端要求字节）',
    },
  ];
  const uploadInfo: Ntv2UploadInfoInput[] = [
    {
      fileInfo: {
        fileSize: bytes.length,
        fileHash: hashes.md5Hex,
        fileSha1: hashes.sha1Hex,
        fileName,
        type: { type: 1, picFormat, videoFormat: 0, voiceFormat: 0 },
        width,
        height,
        time: 0,
        original: 1,
      },
      subFileType: 0,
    },
  ];

  const upload = await runNtv2Upload(nt, pid, {
    uin: target.uin,
    isGroup: target.isGroup,
    targetIdOrUid: resolveTargetId(target, '图片'),
    oidbCmd: target.isGroup ? IMAGE_OIDB_GROUP : IMAGE_OIDB_C2C,
    requestId: 1,
    businessType: MEDIA_BUSINESS_TYPE.image,
    uploadInfo,
    compatQmsgSceneType: target.isGroup ? 2 : 1,
    extBizInfo: {
      pic: {
        bizType: subType,
        textSummary: summary,
        // 群/私聊各带一个 reserve（NapCat：bytesPbReserveTroop / bytesPbReserveC2c），
        // 都填 subType。**漏了不会报错，但服务端不会把文件真的落到该子类型的存储桶，
        // 收端一律显示「图片已过期」** —— 真机验证过的坑，不要省这两个字段。
        ...(target.isGroup
          ? { bytesPbReserveTroop: { subType } }
          : { bytesPbReserveC2c: { subType } }),
      },
      ...extBizPlaceholders(target.isGroup),
    },
    uploads,
    label: '图片',
    log: options.log,
  });

  const msgInfo = finalizeMediaMsgInfo(upload, {
    pic: {
      bizType: subType,
      textSummary: summary,
      ...(target.isGroup
        ? { bytesPbReserveTroop: { subType } }
        : { bytesPbReserveC2c: { subType } }),
    },
  });
  return toResult(upload, msgInfo, {
    businessType: RICH_MEDIA_BUSINESS_TYPE.image,
    fileName,
    fileSize: bytes.length,
    md5Hex: hashes.md5Hex,
    sha1Hex: hashes.sha1Hex,
    width,
    height,
  });
}

// ───────────────────────── 语音 ─────────────────────────

export interface UploadPttParams {
  /** SILK 字节（`silk-wasm` 的 encode 产物）或文件路径。 */
  source: MediaSource;
  /**
   * 时长（秒）—— **必须真实**：收端的气泡宽度与时长文案都来自这个值
   * （`pttDuration`），写 0 会显示 00:00。缺省 0。
   */
  duration?: number;
  /** 波形来源：给 WAV/PCM 出真条，不给则 mock 一条合成条（只是装饰）。 */
  waveform?: PttWaveformSource;
  /** 语音格式标记，缺省 1（与 SL/NapCat 一致）。 */
  voiceFormat?: number;
  /** 缺省 `<md5>.amr`（SL 同）。 */
  fileName?: string;
}

const PTT_RESERVE_LEGACY = new Uint8Array([0x08, 0x00, 0x38, 0x00]);

/**
 * `extBizInfo.ptt.bytesReserve`。
 *
 * - 群聊：4 字节 `{1:0, 7:0}`（NapCat / SnowLuma 同）——实测能发出、收端能播能画波形。
 * - 私聊：安卓真机抓包（`0x126d_100`）是一段 **33 字节容器**：
 *
 *   ```
 *   05 02 00 01 00 |\
 *   04 00 04 <clientRandomId BE32> |\
 *   08 00 04 00 00 00 01 |
 *   09 00 04 00 00 00 03 |
 *   0A 00 04 08 00 38 00
 *   ```
 *
 *   尾部 `0A` 项的内容恰好就是群聊那 4 字节 —— 也就是说我们之前只把容器尾巴发出去
 *   了。私聊波形不渲染时就锚在这里（NapCat / SL 同样只发尾巴）。
 */
export function buildPttReserve(
  target: MediaUploadTarget,
  clientRandomId: bigint | undefined,
): Uint8Array {
  if (target.isGroup || clientRandomId === undefined) return PTT_RESERVE_LEGACY;
  const out = new Uint8Array(33);
  out.set([0x05, 0x02, 0x00, 0x01, 0x00], 0);
  const entry = (offset: number, tag: number, value: readonly number[]) => {
    out[offset] = tag;
    out[offset + 1] = 0x00;
    out[offset + 2] = 0x04;
    out.set(value, offset + 3);
  };
  entry(5, 0x04, [
    Number((clientRandomId >> 24n) & 0xffn),
    Number((clientRandomId >> 16n) & 0xffn),
    Number((clientRandomId >> 8n) & 0xffn),
    Number(clientRandomId & 0xffn),
  ]);
  entry(12, 0x08, [0x00, 0x00, 0x00, 0x01]);
  entry(19, 0x09, [0x00, 0x00, 0x00, 0x03]);
  entry(26, 0x0a, [...PTT_RESERVE_LEGACY]);
  return out;
}

export interface UploadPttResult extends MediaUploadResult {
  /** 波形是合成的（没拿到 PCM/WAV）—— 仅提示，不影响发送。 */
  waveformMocked: boolean;
}

/**
 * 上传一段语音，返回 outgoing commonElem.pbElem。
 *
 * 群聊与私聊的 `bytesGeneralFlags` 不同（照抄 NapCat 的 group/private 两条）——
 * 写错会让旧客户端的兼容消息体解析不出语音，所以按场景分流。
 */
export async function uploadPttMsgInfo(
  nt: MediaNative,
  pid: number,
  target: MediaUploadTarget,
  params: UploadPttParams,
  options: MediaUploadOptions = {},
): Promise<UploadPttResult> {
  const bytes = await readMediaSource(params.source, '语音');
  const hashes = computeHashes(bytes);
  // `fileInfo.time` 是 uint32 秒：调用方给的小数（1.6s）在这里四舍五入，
  // 不要让编码器拿到浮点。
  const duration = Math.round(params.duration ?? 0);
  const voiceFormat = params.voiceFormat ?? 1;
  const fileName = params.fileName ?? `${hashes.md5Hex}.amr`;
  const waveform = buildPttWaveform(params.waveform);
  // 私聊语音的 reserve 里嵌着 clientRandomId，先把随机数定下来（群聊不需要）。
  const clientRandomId = target.isGroup ? undefined : makeClientRandomId();
  const generalFlags = new Uint8Array([0x9a, 0x01, 0x07, 0xaa, 0x03, 0x04, 0x08, 0x08, 0x12, 0x00]);

  const upload = await runNtv2Upload(nt, pid, {
    uin: target.uin,
    isGroup: target.isGroup,
    targetIdOrUid: resolveTargetId(target, '语音'),
    oidbCmd: target.isGroup ? PTT_OIDB_GROUP : PTT_OIDB_C2C,
    // NapCat：群 1 / 私聊 4。照抄。
    requestId: target.isGroup ? 1 : 4,
    businessType: MEDIA_BUSINESS_TYPE.voice,
    uploadInfo: [
      {
        fileInfo: {
          fileSize: bytes.length,
          fileHash: hashes.md5Hex,
          fileSha1: hashes.sha1Hex,
          fileName,
          type: { type: 3, picFormat: 0, videoFormat: 0, voiceFormat },
          width: 0,
          height: 0,
          time: duration,
          original: 0,
        },
        subFileType: 0,
      },
    ],
    compatQmsgSceneType: target.isGroup ? 2 : 1,
    ...(clientRandomId !== undefined ? { clientRandomId } : {}),
    extBizInfo: {
      // 旧版兼容消息体（ptt/video 元素）要有个文案，NapCat 就发这个占位。
      pic: { textSummary: 'Nya~' },
      video: { bytesPbReserve: new Uint8Array(0) },
      ptt: {
        bytesReserve: buildPttReserve(target, clientRandomId),
        bytesPbReserve: new Uint8Array(0),
        // 安卓真机抓包（0x126d_100）里私聊语音**没有**这个字段，群聊那套照旧。
        ...(target.isGroup ? { bytesGeneralFlags: generalFlags } : {}),
        waveform: waveform.bytes,
      },
    },
    uploads: [
      {
        source: 'top',
        cmdId: target.isGroup ? PTT_HIGHWAY_GROUP : PTT_HIGHWAY_C2C,
        bytes,
        md5: hashes.md5,
        sha1: hashes.sha1,
        fastOnlyError: '语音免字节上传不可用（服务端要求字节）',
      },
    ],
    label: '语音',
    log: options.log,
  });

  const msgInfo = finalizeMediaMsgInfo(upload, { pttWaveform: waveform.bytes });
  return {
    ...toResult(upload, msgInfo, {
      // 真机验证：私聊语音用 12（安卓抓包那样）并不会让收端画出波形，B 实验已回滚。
      businessType: RICH_MEDIA_BUSINESS_TYPE.voice,
      fileName,
      fileSize: bytes.length,
      md5Hex: hashes.md5Hex,
      sha1Hex: hashes.sha1Hex,
      width: 0,
      height: 0,
    }),
    waveformMocked: waveform.mocked,
  };
}

// ───────────────────────── 视频 ─────────────────────────

export interface UploadVideoParams {
  /** 视频本体：文件路径（流式上传，不进内存）或字节。 */
  source: MediaSource;
  /** 封面图；不给就用 width/height 合成一张纯色 PNG（不引 ffmpeg）。 */
  thumb?: MediaSource;
  /** 时长（秒）；收端显示 00:00 还是真实时长就看这个值。缺省 0。 */
  duration?: number;
  /** 视频尺寸：群聊会上 wire（缺了安卓端会显示「文件已过期」）；私聊固定发 0。 */
  width?: number;
  height?: number;
  fileName?: string;
  thumbFileName?: string;
}

/**
 * 上传一个视频，返回 outgoing commonElem.pbElem。
 *
 * 视频是两个子文件：正文（`source: 'top'`）与封面（`upload.subFileInfos[0]`），
 * 所以会有两次 highway PUT（除非都命中 fast-upload）。
 *
 * 与 SL 的两处已知取舍：
 *   - 群聊带真实 width/height、私聊发 0（SL issue #145：私聊发真实尺寸会被
 *     服务端按 schema 不匹配拒掉）；
 *   - 封面要么调用方给，要么合成 —— 没有 ffmpeg 抽帧这一步。
 */
export async function uploadVideoMsgInfo(
  nt: MediaNative,
  pid: number,
  target: MediaUploadTarget,
  params: UploadVideoParams,
  options: MediaUploadOptions = {},
): Promise<MediaUploadResult> {
  const isFile = typeof params.source === 'string';
  const size = isFile
    ? (await fsp.stat(params.source as string)).size
    : (params.source as Uint8Array).length;
  if (size === 0) throw new Error('视频文件是空的');

  const videoHashes = isFile
    ? await hashVideoFile(params.source as string, size)
    : hashVideoBytes(params.source as Uint8Array);
  const fileName = params.fileName ?? `${videoHashes.md5Hex}.mp4`;

  const width = params.width ?? 0;
  const height = params.height ?? 0;
  // 封面：显式给的优先；否则合成一张「声明尺寸 = 真实像素」的纯色 PNG。
  const thumbBytes = params.thumb
    ? await readMediaSource(params.thumb, '视频封面')
    : makeSolidPng(
        width > 0 ? width : DEFAULT_VIDEO_THUMB_WIDTH,
        height > 0 ? height : DEFAULT_VIDEO_THUMB_HEIGHT,
      );
  const thumbFormat = detectImageFormat(thumbBytes);
  const thumbHashes = computeHashes(thumbBytes);
  const thumbFileName =
    params.thumbFileName ??
    `${thumbHashes.md5Hex}${PIC_EXT_BY_FORMAT[thumbFormat.format] ?? '.jpg'}`;

  const upload = await runNtv2Upload(nt, pid, {
    uin: target.uin,
    isGroup: target.isGroup,
    targetIdOrUid: resolveTargetId(target, '视频'),
    oidbCmd: target.isGroup ? VIDEO_OIDB_GROUP : VIDEO_OIDB_C2C,
    requestId: 3,
    businessType: MEDIA_BUSINESS_TYPE.video,
    uploadInfo: [
      {
        fileInfo: {
          fileSize: size,
          fileHash: videoHashes.md5Hex,
          fileSha1: videoHashes.sha1Hex,
          fileName,
          type: { type: 2, picFormat: 0, videoFormat: 0, voiceFormat: 0 },
          width: target.isGroup ? width : 0,
          height: target.isGroup ? height : 0,
          time: Math.round(params.duration ?? 0),
          original: 0,
        },
        subFileType: 0,
      },
      {
        fileInfo: {
          fileSize: thumbBytes.length,
          fileHash: thumbHashes.md5Hex,
          fileSha1: thumbHashes.sha1Hex,
          fileName: thumbFileName,
          type: { type: 1, picFormat: 0, videoFormat: 0, voiceFormat: 0 },
          width: thumbFormat.width,
          height: thumbFormat.height,
          time: 0,
          original: 0,
        },
        subFileType: 100,
      },
    ],
    // 视频固定 2（连私聊也是）：老 videoFile 元素没有场景之分，给 1 会让服务端
    // 生成私聊形状的兼容体，旧客户端显示「视频已过期」（SL 同）。
    compatQmsgSceneType: 2,
    extBizInfo: {
      pic: { bizType: 0, textSummary: 'Nya~' },
      video: { bytesPbReserve: new Uint8Array([0x80, 0x01, 0x00]) },
      ptt: {
        bytesPbReserve: new Uint8Array(0),
        bytesReserve: new Uint8Array(0),
        bytesGeneralFlags: new Uint8Array(0),
      },
    },
    uploads: [
      {
        source: 'top',
        cmdId: target.isGroup ? VIDEO_HIGHWAY_GROUP : VIDEO_HIGHWAY_C2C,
        ...(isFile
          ? { fileSource: { filePath: params.source as string, fileSize: size } }
          : { bytes: params.source as Uint8Array }),
        md5: videoHashes.md5,
        // 视频主文件要带分块 sha1（服务端按块校验 + 拼接）。
        sha1: videoHashes.sha1Blocks,
        subFileIndex: 0,
        fastOnlyError: '视频免字节上传不可用（服务端要求字节）',
      },
      {
        source: 0,
        cmdId: target.isGroup ? VIDEO_THUMB_HIGHWAY_GROUP : VIDEO_THUMB_HIGHWAY_C2C,
        bytes: thumbBytes,
        md5: thumbHashes.md5,
        sha1: thumbHashes.sha1,
        subFileIndex: 1,
        // 封面永远有字节（最差是合成图），所以不设 fastOnlyError。
      },
    ],
    label: '视频',
    log: options.log,
  });

  const msgInfo = finalizeMediaMsgInfo(upload);
  return toResult(upload, msgInfo, {
    businessType: RICH_MEDIA_BUSINESS_TYPE.video,
    fileName,
    fileSize: size,
    md5Hex: videoHashes.md5Hex,
    sha1Hex: videoHashes.sha1Hex,
    width: thumbFormat.width,
    height: thumbFormat.height,
  });
}

/** 兜底纯色 PNG 的常量导出（测试与调用方判断封面来源用）。 */
export { PIC_FORMAT_JPEG, PIC_FORMAT_PNG };
