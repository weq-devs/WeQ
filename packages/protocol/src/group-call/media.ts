/**
 * 群通话的媒体帧（`0x17` 上行 / `0x18` 下行）。
 *
 * 与私聊 `call/video.ts` 的 `0x5b` 完全不同：群聊的媒体载荷也塞在 `0x02` 通道里，
 * 外层包头（17 字节）之后是一段**变长的媒体头**，`body[16]` 的 track 类型决定它
 * 是音频还是视频。
 *
 * ```text
 * body[0:7]    流标识（`18 57 06 aa XX XX 00`，每成员不同）
 * body[7]      0x01（c2s）/ 0x02（s2c）—— 方向
 * body[8]      0xa7（音频）/ 0x83（视频）
 * body[9:14]   包序号（5B，逐包递增）
 * body[14]     音频 0x79 / 视频 0x83
 * body[15]     音频 0xa7（c2s）/ 0x05（s2c）；视频 0xa7
 * body[16]     **track 类型**：1 = 音频，2 = 视频，3 = 视频（另一路编码）
 * body[17]     音频 0x01；视频 0x07 / 0x01 / 0x00
 * body[18]     音频 **分片标记**（0x00 = 媒体数据，0x10 = 成员信息包，
 *              0x50 = 带 FEC）；视频 **分片序号 pkgIdx**
 * ```
 *
 * ## 音频载荷定位（2026-11-05 用 `nt_helper.decodeCallFrame` 逐包验证）
 *
 * `body[20]` 的 bit7 决定长度字段的位置：
 *
 * ```text
 * body[20] & 0x80 == 0  → 长度在 body[30]，载荷从 body[32] 开始
 * body[20] & 0x80 != 0  → 长度在 body[35]，载荷从 body[37] 开始
 * ```
 *
 * 长度三元组是 `L | (L-2) & 0xff | 00`，`L` 就是 Opus 载荷的字节数，载荷是紧跟在
 * 长度字段之后的 `L` 字节（起点 = 长度字段 + 2，首字节是 Opus TOC 0x00 = SILK
 * 窄带 10 ms）。两种形态合起来对三份抓包的解码率是 100%（159/159、135/135），
 * 解码出的都是真实语音（平均振幅 7000+）。
 *
 * > ⚠️ 早期版本把载荷起点固定成 `b[19]`，后来又试过 `b[33]`，都只能解出一部分包。
 * > 真正的分界是 `body[20]` 的 bit7，别再用固定偏移。
 * >
 * > 长度三元组同时是**成员信息包**的排除条件：那类包（`body[18] = 0x10`，
 * > 36 字节）的 `body[30] = 0x04`、`body[31] = 0x00`，不满足 `L-2` 校验，会被丢掉。
 *
 * ## 视频分片（2026-11-05 三份抓包 100% 对齐）
 *
 * - `body[18]` = pkgIdx，载荷固定从 `body[35]` 开始（`body[33:35]` 恒 `00 00`）
 * - `body[22]` **不是**分片总数（实测 3 片的帧里它是 0x0e）；`body[19]` 也不可靠
 *   （FEC 冗余片会让它小于实际片数）。**完整性只能靠 pkgIdx 从 0 递增判定**
 * - 每帧首片（`pkgIdx = 0`）以 `00 00 00 01` 起始码开头，续片是裸续字节
 * - 重组后是标准 Annex B H.264：`SPS 67 64 00 1f`（High 3.1）+ `PPS 68 ee 3c 80`
 *
 * ## 没有 P2P
 *
 * 群聊全部媒体都走服务器中继，`0x02` 包头的 `[13:17]` 指明谁发的流。
 */

import { u16be, u32be, writeU32be } from '../call/gcs';

// ─────────────────────────── 常量 ───────────────────────────

/** `body[16]`：track 类型的位置。 */
const TRACK_OFFSET = 16;
/** 音频长度字段的两种位置，由 `body[20]` 的 bit7 决定。 */
const AUDIO_LEN_OFFSET_PLAIN = 30;
const AUDIO_LEN_OFFSET_EXT = 35;
/**
 * 载荷起点相对长度字段的偏移。
 *
 * 实测载荷就是紧跟在 `L | (L-2) | 00` 之后的那 `L` 个字节，其中第一个字节是
 * Opus TOC（0x00 = SILK 窄带 10 ms 单声道），所以起点是 `长度字段 + 2`。
 */
const AUDIO_PAYLOAD_DELTA = 2;
/** 视频分片载荷起点。 */
const VIDEO_PAYLOAD_OFFSET = 35;
/** 视频分片头里 pkgIdx 的位置。 */
const VIDEO_IDX_OFFSET = 18;
/** 视频分片头里总分片数的位置（`body[19]`）。 */
const VIDEO_TOTAL_OFFSET = 19;

/** 媒体包里的 track 类型（`body[16]`）。 */
export const GroupTrack = {
  /** 音频（Opus）。 */
  audio: 1,
  /** 视频（H.264）。 */
  video: 2,
  /** 视频的另一路编码（③ 里自己上行出现过，载荷同样是 H.264 Annex B）。 */
  videoAlt: 3,
} as const;

/** 音频分片标记（`body[18]`）。 */
export const GroupAudioFragmentFlag = {
  /** 媒体数据。 */
  media: 0x00,
  /** 成员信息包（36 字节，不是音频载荷）。 */
  memberInfo: 0x10,
  /** 带 FEC 冗余的媒体数据。 */
  fec: 0x50,
} as const;

/** H.264 Annex B 起始码。 */
export const H264_START_CODE = Uint8Array.from([0x00, 0x00, 0x00, 0x01]);

// ─────────────────────────── 解析 ───────────────────────────

/** 解析后的媒体头（`0x17` / `0x18` 共用）。 */
export interface GroupMediaHeader {
  /** `body[0:7]` 流标识。 */
  stream: Uint8Array;
  /** `body[7]`：0x01 = c2s，0x02 = s2c。 */
  direction: number;
  /** `body[8]`：0xa7（音频）/ 0x83（视频）。 */
  codec: number;
  /** `body[9:14]` 的包序号（5B 大端）。 */
  seq: number;
  /** `body[16]`：track 类型，见 {@link GroupTrack}。 */
  track: number;
}

/** 解析媒体头；track 类型不认识时返回 `null`。 */
export function parseGroupMediaHeader(body: Uint8Array): GroupMediaHeader | null {
  if (body.length < TRACK_OFFSET + 1) return null;
  const track = body[TRACK_OFFSET]!;
  if (track !== GroupTrack.audio && track !== GroupTrack.video && track !== GroupTrack.videoAlt) {
    return null;
  }
  return {
    stream: body.subarray(0, 7),
    direction: body[7]!,
    codec: body[8]!,
    seq: readSeq5(body, 9),
    track,
  };
}

/** 解析后的音频帧。 */
export interface GroupAudioFrame {
  /** 分片标记（`body[18]`），见 {@link GroupAudioFragmentFlag}。 */
  fragmentFlag: number;
  /** Opus 载荷（已按长度字段切好）。 */
  payload: Uint8Array;
  /** 长度字段里声明的载荷长度（= `payload.length`）。 */
  declaredLength: number;
  /** 完整 body，调试用。 */
  raw: Uint8Array;
}

/**
 * 从音频 body 里切出 Opus 载荷。
 *
 * 长度字段位置由 `body[20]` 的 bit7 决定（见模块注释），载荷长度就是字段值本身。
 * 三元组校验不过时返回 `null` —— 这类包是成员信息包（`body[18] = 0x10`），
 * 不是音频。
 */
export function parseGroupAudioFrame(body: Uint8Array): GroupAudioFrame | null {
  const lenOffset = (body[20] ?? 0) & 0x80 ? AUDIO_LEN_OFFSET_EXT : AUDIO_LEN_OFFSET_PLAIN;
  if (body.length < lenOffset + 3) return null;

  const declaredLength = body[lenOffset]!;
  if (declaredLength < 3) return null;
  // 冗余校验：后一字节恒为 L-2，再后一字节恒为 0。
  if (body[lenOffset + 1] !== ((declaredLength - 2) & 0xff)) return null;
  if (body[lenOffset + 2] !== 0x00) return null;

  const start = lenOffset + AUDIO_PAYLOAD_DELTA;
  const end = start + declaredLength;
  if (end > body.length) return null;

  return {
    fragmentFlag: body[18] ?? 0,
    payload: body.subarray(start, end),
    declaredLength,
    raw: body,
  };
}

/** 单个视频分片。 */
export interface GroupVideoFragment {
  /** 本片在帧内的序号（`body[18]`）。 */
  pkgIdx: number;
  /** 本帧总分片数（`body[19]`）。0 表示对端没填。 */
  totalPkg: number;
  /** 分片载荷（已去掉分片头）。 */
  payload: Uint8Array;
  /** 完整 body，调试用。 */
  raw: Uint8Array;
}

/**
 * 从视频 body 里切出分片载荷。
 *
 * 载荷固定从 `body[35]` 开始。
 */
export function parseGroupVideoFragment(body: Uint8Array): GroupVideoFragment | null {
  if (body.length <= VIDEO_PAYLOAD_OFFSET) return null;
  return {
    pkgIdx: body[VIDEO_IDX_OFFSET] ?? 0,
    totalPkg: body[VIDEO_TOTAL_OFFSET] ?? 0,
    payload: body.subarray(VIDEO_PAYLOAD_OFFSET),
    raw: body,
  };
}

// ─────────────────────────── 视频重组 ───────────────────────────

/** 重组后的一帧 H.264（Annex B）。 */
export interface GroupVideoFrame {
  /** Annex B 裸流（首片带 `00 00 00 01` 起始码）。 */
  data: Uint8Array;
  /** 是否关键帧（含 IDR / SPS NAL）。 */
  keyframe: boolean;
  /** 本帧实际收到的分片数。 */
  fragments: number;
  /** 该帧所属的成员 uin（`0x02` 包头的 `[13:17]`）。 */
  ownerUin: number;
}

/**
 * 按成员把视频分片重组成完整帧。
 *
 * 群聊是 N 路流，**每个成员各自一套分片序列**，所以按 `ownerUin` 分开维护。
 * `pkgIdx = 0` 开启新帧，其余分片按序追加；遇到序号跳变就丢弃当前帧（宁可丢一帧，
 * 也不要把两帧的字节拼在一起）。
 *
 * ⚠️ 抓包里的 `body[22]` 不是分片总数（3 片的帧里它是 0x0e），`body[19]` 也不可靠
 * （FEC 冗余片会让它偏小），所以这里**不按总数等齐**，而是首片一到就先交出去。
 * 代价是丢片时会交出被截断的帧 —— 对 H.264 来说截断帧会被解码器丢弃，不影响
 * 后续帧，比「等齐再交」更抗丢包。
 */
export class GroupVideoAssembler {
  /** 每个成员正在攒的那一帧：已收到的分片 + 本帧总分片数。 */
  private readonly pending = new Map<number, { chunks: Uint8Array[]; total: number }>();

  /**
   * 喂一个分片。
   *
   * **收齐 `totalPkg` 才返回整帧** —— 早先的实现每片都 emit 一版半截数据，
   * 下游拿到的「帧」缺尾巴，解出来是花的（实机验证：对端音频正常、视频花屏）。
   * 分片数不对或序号跳变时丢弃整帧，等下一个首片。
   *
   * @returns 完整帧；还在攒片时返回 `null`。
   */
  push(ownerUin: number, fragment: GroupVideoFragment): GroupVideoFrame | null {
    const { pkgIdx, payload, totalPkg } = fragment;
    if (pkgIdx === 0) {
      // 新帧开始：上一帧没凑齐就丢掉。
      this.pending.set(ownerUin, { chunks: [payload], total: totalPkg });
      return this.maybeEmit(ownerUin);
    }
    const state = this.pending.get(ownerUin);
    // 没有首片、或序号跳变：丢弃，等下一帧的 pkgIdx=0。
    if (!state || pkgIdx !== state.chunks.length) {
      this.pending.delete(ownerUin);
      return null;
    }
    state.chunks.push(payload);
    return this.maybeEmit(ownerUin);
  }

  /** 清掉某个成员（或全部）的待重组状态，例如成员离开时。 */
  reset(ownerUin?: number): void {
    if (ownerUin === undefined) this.pending.clear();
    else this.pending.delete(ownerUin);
  }

  private maybeEmit(ownerUin: number): GroupVideoFrame | null {
    const state = this.pending.get(ownerUin);
    if (!state) return null;
    // totalPkg 为 0（抓包里个别包没填）时按 1 处理，避免永远攒不齐。
    const total = state.total > 0 ? state.total : 1;
    if (state.chunks.length < total) return null;
    this.pending.delete(ownerUin);
    const data = concat(state.chunks);
    return {
      data,
      keyframe: hasIdrNal(data),
      fragments: state.chunks.length,
      ownerUin,
    };
  }
}

/**
 * 扫一遍 Annex B 流，看有没有 IDR（NAL type 5）或 SPS（7）。
 *
 * 首片一定带起始码，所以只要顺着起始码走就能逐个 NAL 判类型。
 */
export function hasIdrNal(data: Uint8Array): boolean {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x00 && data[i + 3] === 0x01) {
      const nalType = data[i + 4]! & 0x1f;
      if (nalType === 5 || nalType === 7) return true;
      i += 3; // 循环还会 +1，合起来跳过起始码
    }
  }
  return false;
}

// ─────────────────────────── 组包 ───────────────────────────

/**
 * 组一个音频上行包（`0x17`）。
 *
 * 只做「媒体数据」这一种形态（`body[18] = 0x00`）；带 FEC 的形态（`0x50`）留给
 * 后续补冗余时再扩。
 *
 * 字段取自 ③ 的真实上行包，其中：
 * - `frameIndex`（`body[24]`）每帧 +1
 * - `sampleTs`（`body[25:29]`）每 20 ms 帧 +320 采样
 *
 * 其余字节是三份抓包里恒定的占位，**换 QQ 版本后要重新核对**。
 */
export function buildGroupAudioFrame(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  seq: number;
  frameIndex: number;
  sampleTs: number;
  opus: Uint8Array;
}): Uint8Array {
  assertStream(params.stream);
  const len = params.opus.length;
  if (len < 3 || len > 0xfe) throw new RangeError(`Opus 帧长度不合法：${len}`);

  const body = new Uint8Array(AUDIO_LEN_OFFSET_PLAIN + AUDIO_PAYLOAD_DELTA + len);
  body.set(params.stream, 0);
  body[7] = 0x01; // c2s
  body[8] = 0xa7;
  writeSeq5(body, 9, params.seq);
  body[14] = 0x79;
  body[15] = 0xa7;
  body[16] = GroupTrack.audio;
  body[17] = 0x01;
  body[18] = GroupAudioFragmentFlag.media;
  body[19] = 0x03;
  body[20] = 0x3e; // bit7 = 0 → 长度字段在 30
  body[21] = 0x01;
  body[22] = 0x25;
  body[23] = 0x00;
  body[24] = params.frameIndex & 0xff;
  writeU32be(body, 25, params.sampleTs >>> 0);
  body[29] = 0x00;
  body[AUDIO_LEN_OFFSET_PLAIN] = len;
  body[AUDIO_LEN_OFFSET_PLAIN + 1] = (len - 2) & 0xff;
  body[AUDIO_LEN_OFFSET_PLAIN + 2] = 0x00;
  body.set(params.opus, AUDIO_LEN_OFFSET_PLAIN + AUDIO_PAYLOAD_DELTA);

  return wrapMedia(params.route, params.ownerUin, body);
}

/**
 * 把一个 H.264 帧切成若干个视频分片（`0x17`）。
 *
 * 分片上限默认 1000 字节：抓包里单包载荷最大约 1100，留一点余量避免超过 MTU 太多。
 */
export function buildGroupVideoFragments(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  seq: number;
  /** Annex B 裸流。 */
  data: Uint8Array;
  /** 每片载荷上限。 */
  maxPayload?: number;
  /** 本帧是否关键帧（决定 `body[17]` 首片是 0x00 还是 0x07）。 */
  keyframe?: boolean;
}): Uint8Array[] {
  assertStream(params.stream);
  const maxPayload = params.maxPayload ?? 1000;
  if (maxPayload < 16) throw new RangeError('分片上限太小');

  const total = Math.ceil(params.data.length / maxPayload);
  if (total > 0xff) throw new RangeError(`分片数超过 255：${total}`);

  const out: Uint8Array[] = [];
  for (let idx = 0; idx < total; idx++) {
    const start = idx * maxPayload;
    const chunk = params.data.subarray(start, Math.min(params.data.length, start + maxPayload));
    const body = new Uint8Array(VIDEO_PAYLOAD_OFFSET + chunk.length);
    // 字段布局按 698 个真实上行视频包统计得出（见文件头注释）。
    body.set(params.stream, 0);
    body[7] = 0x01; // c2s
    body[8] = 0xa7; // codec 标记
    body[9] = 0x83; // 视频标记
    // 序号是 4 字节（[10:14]），不是 5 字节。
    writeU32be(body, 10, (params.seq + idx) >>> 0);
    body[14] = 0x83;
    body[15] = 0xa7;
    body[16] = GroupTrack.video;
    // [17]：关键帧首片 0x00，其余 0x07（实测 698 包里只有关键帧首片是 0）。
    body[17] = idx === 0 && params.keyframe ? 0x00 : 0x07;
    body[18] = idx;
    body[19] = total; // 本帧总分片数
    body[20] = 0x00;
    body[21] = 0x0c;
    body[22] = idx; // pkgIdx（与 [18] 同值）
    body[23] = 0x01;
    body[24] = 0x04;
    body[25] = 0x04;
    body[26] = 0x02;
    body[28] = 0x04;
    body[29] = 0x08;
    body.set(chunk, VIDEO_PAYLOAD_OFFSET);
    out.push(wrapMedia(params.route, params.ownerUin, body));
  }
  return out;
}

// ─────────────────────────── 小工具 ───────────────────────────

/** 读 5 字节大端序号。 */
export function readSeq5(buf: Uint8Array, off: number): number {
  return u32be(buf, off) * 256 + buf[off + 4]!;
}

function writeSeq5(buf: Uint8Array, off: number, value: number): void {
  buf[off] = Math.floor(value / 0x100000000) & 0xff;
  writeU32be(buf, off + 1, value >>> 0);
}

/** 把媒体 body 包进 `0x02` 外层（`kind = 0x04`、`cmd = 0x17`）。 */
function wrapMedia(route: number, ownerUin: number, body: Uint8Array): Uint8Array {
  const total = 17 + body.length + 1;
  if (total > 0xffff) throw new RangeError(`群通话媒体包超过 65535 字节：${total}`);
  const out = new Uint8Array(total);
  out[0] = 0x02;
  out[1] = (total >>> 8) & 0xff;
  out[2] = total & 0xff;
  // 上行媒体的 kind 实测是 **0x00**（不是 0x04）。
  // 抓包统计：c2s `0x17` 全部 kind=0x00（920 包），s2c `0x18` 是 0x03（1051 包）。
  // 之前写 0x04 会让服务端/对端把我们的媒体包当未知类型丢掉。
  out[3] = 0x00;
  out[4] = (route >>> 16) & 0xff;
  out[5] = (route >>> 8) & 0xff;
  out[6] = route & 0xff;
  out[7] = 0x00;
  out[8] = 0x17;
  writeU32be(out, 13, ownerUin);
  out.set(body, 17);
  out[out.length - 1] = 0x03;
  return out;
}

function assertStream(stream: Uint8Array): void {
  if (stream.length !== 7) throw new RangeError(`流标识必须是 7 字节，收到 ${stream.length}`);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

/** 媒体包是否是 `0x17` / `0x18`。 */
export function isGroupMediaCmd(cmd: number): boolean {
  return cmd === 0x17 || cmd === 0x18;
}

/** 媒体包的 `[1:3]` 长度字段（导出给测试用）。 */
export function mediaPacketLength(data: Uint8Array): number {
  return u16be(data, 1);
}
