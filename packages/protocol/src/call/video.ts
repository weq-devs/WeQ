/**
 * 视频通话的媒体层：视频帧（`0x5b subType=2/3/7`）与摄像头开关控制包（`subType=4`）。
 *
 * 与音频共用 17 字节外层头（`0x5b`），但载荷是另一套结构：外层头之后是 6 字节
 * 视频 RTP 头 + 可选扩展段 + 加密无关的明文 H.265 Annex B。
 *
 * 实测（2026-10-25，两通真实视频通话，一收一发）确认的格式：
 *
 * ```text
 * 0x5b 头 17B        [3]=subType  [5:9]=seq  [9:13]=sessionTs  [13:17]=tick
 *   ↓
 * 视频 RTP 头 6B     pkg_idx | total_pkg | total_fec | ext_fec_byte | gidx | fidx
 *   ↓
 * 扩展段             ext_fec_byte 低 5 位 ∈ [11,20] 时有 (值-10) 条 [len][type][data]
 *   ↓ （同一帧的各分片按 pkg_idx 拼起来）
 * sub-header N B     首字节 = N（实测 20）；[8:12] = 真实帧时间戳（ms）
 *   ↓
 * H.265 Annex B      以 00 00 00 01 起始码开头，**明文**
 * ```
 *
 * 帧的归属靠 `(gidx, fidx)`：`fidx=1` 是基础层（可独立解码），`fidx>=2` 是时域
 * 增强层（依赖基础层，跳过可避免花屏）。同一个 GOP 内 `gidx` 递增。
 *
 * ⚠️ 与音频的差异：音频把 `[13:17]` 当 tick 用，视频这里也是每包递增的 tick；
 * 而 `[9:13]` 两侧都是**每方向恒定的会话时钟**（实测 c2s/s2c 各差 1），不是
 * 每包变化的时间戳。真正的帧时间戳在 sub-header 里。
 */

import { AUDIO_HEADER_LEN, AUDIO_STX, u32be, writeU16be, writeU32be } from './gcs';

// ═══════════════════════════ 常量 ═══════════════════════════

/** `0x5b` 的视频子类型。 */
export const VideoSubType = {
  /** 大画面。实测 c2c 视频通话用的就是它。 */
  max: 0x02,
  /** 小画面。 */
  min: 0x03,
  /** 屏幕共享。 */
  screen: 0x07,
} as const;

/** 摄像头开关控制包（空体，连发两次）。 */
export const VIDEO_CTRL_SUB_TYPE = 0x04;

/** 视频会话保活 / 统计包。每 2 秒一次，视频停了还在发，直到挂断。 */
export const VIDEO_KEEPALIVE_SUB_TYPE = 0x05;

/** 视频 RTP 头长度。 */
export const VIDEO_RTP_HEADER_LEN = 6;

/** 扩展段起始偏移（RTP 头之后）。 */
const EXT_OFFSET = VIDEO_RTP_HEADER_LEN;

/**
 * 我们发的包里那条扩展的长度（`[len][type][data]` 三个字节，data 空）。
 *
 * 实测真实客户端在 `ext_fec_byte` 低位写 `0x0b`（= 11 → 1 条扩展），扩展体是
 * `02 03`（len=2，type=3，无数据）。这 2 字节必须真的写进去，否则接收端按
 * `dataOffset` 取载荷会整体错位 2 字节。
 */
const EXT_HEADER_LEN = 2;

/** 组帧超时：超过这个时间还没凑齐的分片直接丢掉。 */
export const VIDEO_FRAME_TIMEOUT_MS = 4000;

/** 同时等待组装的帧数上限（超出按最早到达淘汰）。 */
export const VIDEO_MAX_PENDING_FRAMES = 256;

// ═══════════════════════════ 解析 ═══════════════════════════

/** 一个视频包的 RTP 头 + 扩展。 */
export interface VideoRtpHeader {
  /** 帧内分片序号，从 0 起。 */
  pkgIdx: number;
  /** 本帧总分片数。 */
  totalPkg: number;
  /** RS-FEC 冗余包数。 */
  totalFec: number;
  /** 跨帧 FEC 冗余数（`ext_fec_byte >> 5`，>3 视为非法）。 */
  multiFrameFec: number;
  /** GOP 索引。 */
  gidx: number;
  /** GOP 内的帧索引：1 = 基础层，>=2 = 增强层。 */
  fidx: number;
  /** 扩展段解析结果。 */
  extensions: VideoExtension[];
  /** 载荷（sub-header 起始）在整包里的偏移。 */
  dataOffset: number;
}

export interface VideoExtension {
  type: number;
  data: Uint8Array;
}

/** 一个完整的视频包。 */
export interface VideoPacket {
  subType: number;
  seq: number;
  sessionTs: number;
  tick: number;
  rtp: VideoRtpHeader;
  /** sub-header + H.265 数据。 */
  payload: Uint8Array;
}

/** 是否为视频子类型。 */
export function isVideoSubType(subType: number): boolean {
  return (
    subType === VideoSubType.max || subType === VideoSubType.min || subType === VideoSubType.screen
  );
}

/**
 * 解析一个视频包。
 *
 * 入参是**完整 UDP 载荷**（含 17 字节外层头）。子类型不对时返回 null —— 调用方
 * 通常已经按 subType 分流过，这里是防御。
 */
export function parseVideoPacket(data: Uint8Array): VideoPacket | null {
  if (data.length < AUDIO_HEADER_LEN + VIDEO_RTP_HEADER_LEN) return null;
  if (data[0] !== AUDIO_STX) return null;
  const subType = data[3]!;
  if (!isVideoSubType(subType)) return null;

  const payload = data.subarray(AUDIO_HEADER_LEN);
  const rtp = parseVideoRtpHeader(payload);
  if (!rtp) return null;

  return {
    subType,
    seq: u32be(data, 5),
    sessionTs: u32be(data, 9),
    tick: u32be(data, 13),
    rtp,
    payload: payload.subarray(rtp.dataOffset),
  };
}

/** 解析 6 字节视频 RTP 头与随后的扩展段。 */
export function parseVideoRtpHeader(payload: Uint8Array): VideoRtpHeader | null {
  if (payload.length < VIDEO_RTP_HEADER_LEN) return null;

  const pkgIdx = payload[0]!;
  const totalPkg = payload[1]!;
  const totalFec = payload[2]!;
  const extFecByte = payload[3]!;
  const gidx = payload[4]!;
  const fidx = payload[5]!;

  const multiFrameFec = extFecByte >> 5;
  // 实测冗余数不会超过 3；超了说明这不是视频包。
  if (multiFrameFec > 3) return null;

  const extVal = extFecByte & 0x1f;
  // 低 5 位在 11..20 之间表示「有 (值 - 10) 条扩展」。
  const extCount = extVal >= 11 && extVal <= 20 ? extVal - 10 : 0;

  const extensions: VideoExtension[] = [];
  let off = EXT_OFFSET;
  for (let i = 0; i < extCount; i++) {
    if (off >= payload.length) break;
    const len = payload[off]!;
    // len 含它自己那 1 字节；0 或越界说明扩展段坏了，就此打住。
    if (len < 2 || off + len > payload.length) break;
    extensions.push({
      type: payload[off + 1]!,
      data: payload.subarray(off + 2, off + len),
    });
    off += len;
  }

  return {
    pkgIdx,
    totalPkg,
    totalFec,
    multiFrameFec,
    gidx,
    fidx,
    extensions,
    dataOffset: off,
  };
}

// ═══════════════════════════ 组帧 ═══════════════════════════

/** 组装完成的一帧。 */
export interface VideoFrame {
  gidx: number;
  fidx: number;
  /** 同一帧的各个分片共用（视频里就是 ssrc 的位置）。 */
  tick: number;
  subType: number;
  /** 基础层（`fidx === 1`）才能独立解码。 */
  isBaseLayer: boolean;
  /**
   * 是否为关键帧（IRAP：IDR / CRA / BLA）。
   *
   * **不能**用 `gidx === 0` 判：gidx 在通话内单调递增，而编码器会按需插入新的
   * 关键帧（开摄像头、网络恢复、周期性刷新）。`VideoDecoder` 在 `configure()`
   * 之后必须先吃到一个关键帧，否则直接抛 `DataError: A key frame is required`。
   * 所以这里按 NAL 类型判，见 {@link isIrapNalType}。
   */
  isKeyframe: boolean;
  /** sub-header 长度（`frameData[0]`，实测 20）。 */
  subHeaderSize: number;
  /** 真实帧时间戳（ms），取自 sub-header[8:12]。 */
  timestamp: number;
  /** 拼好的原始数据（含 sub-header）。 */
  frameData: Uint8Array;
  /** 首个分片到达的时刻（毫秒）。 */
  firstAt: number;
}

interface PendingFrame {
  gidx: number;
  fidx: number;
  tick: number;
  subType: number;
  totalPkg: number;
  parts: Map<number, Uint8Array>;
  firstAt: number;
  lastAt: number;
}

/**
 * 视频帧组装器。
 *
 * 按 `(gidx, fidx)` 收集分片，凑齐 `totalPkg` 个就拼成一帧吐出来。乱序、重复、
 * 超时都按音频那边同样的口径处理：重复丢弃、超时 4 秒清理、等待数超上限时淘汰
 * 最早到达的。
 *
 * 不做 FEC 恢复 —— 实测 c2c 视频走 UDP 直连，丢包率低；而且缺一片的帧本来也
 * 解不出来，恢复了也是花屏。真需要时再加。
 */
export class VideoFrameAssembler {
  private readonly pending = new Map<string, PendingFrame>();

  /** 喂一个包；凑齐一整帧时返回它，否则 null。 */
  push(packet: VideoPacket, now = Date.now()): VideoFrame | null {
    this.evictStale(now);

    const { rtp, tick, subType, payload } = packet;
    if (rtp.totalPkg === 0) return null;
    const key = `${rtp.gidx}:${rtp.fidx}`;
    let slot = this.pending.get(key);
    if (!slot) {
      if (this.pending.size >= VIDEO_MAX_PENDING_FRAMES) this.evictOldest();
      slot = {
        gidx: rtp.gidx,
        fidx: rtp.fidx,
        tick,
        subType,
        totalPkg: rtp.totalPkg,
        parts: new Map(),
        firstAt: now,
        lastAt: now,
      };
      this.pending.set(key, slot);
    }
    // 同一分片重复到达（重传 / 回绕）只留第一份。
    if (slot.parts.has(rtp.pkgIdx)) return null;
    slot.parts.set(rtp.pkgIdx, payload);
    slot.lastAt = now;
    slot.totalPkg = Math.max(slot.totalPkg, rtp.totalPkg);

    if (slot.parts.size < slot.totalPkg) return null;
    this.pending.delete(key);
    return assemble(slot);
  }

  /** 清空（挂断时调用）。 */
  reset(): void {
    this.pending.clear();
  }

  /** 正在等待组装的分片组数量（调试用）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  private evictStale(now: number): void {
    for (const [key, slot] of this.pending) {
      if (now - slot.lastAt > VIDEO_FRAME_TIMEOUT_MS) this.pending.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, slot] of this.pending) {
      if (slot.firstAt < oldest) {
        oldest = slot.firstAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.pending.delete(oldestKey);
  }
}

function assemble(slot: PendingFrame): VideoFrame {
  let total = 0;
  for (let i = 0; i < slot.totalPkg; i++) total += slot.parts.get(i)?.length ?? 0;
  const frameData = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < slot.totalPkg; i++) {
    const part = slot.parts.get(i);
    if (!part) continue;
    frameData.set(part, off);
    off += part.length;
  }

  // 首字节就是 sub-header 长度（实测 20）；异常时退回 0，让调用方拿到完整数据。
  const subHeaderSize =
    frameData.length > 0 && frameData[0]! < frameData.length ? frameData[0]! : 0;
  // sub-header[8:12] 是真实帧时间戳（ms）。外层的 tick 不是它。
  const timestamp = frameData.length >= 12 ? u32be(frameData, 8) : 0;

  return {
    gidx: slot.gidx,
    fidx: slot.fidx,
    tick: slot.tick,
    subType: slot.subType,
    isBaseLayer: slot.fidx === 1,
    // 关键帧按 NAL 类型判，不能按 gidx —— 见 `VideoFrame.isKeyframe` 的注释。
    isKeyframe: containsIrap(frameData, subHeaderSize),
    subHeaderSize,
    timestamp,
    frameData,
    firstAt: slot.firstAt,
  };
}

// ═══════════════════════════ H.265 提取 ═══════════════════════════

/** 一个 NAL 单元。 */
export interface HevcNal {
  /** NAL 类型（HEVC：`(byte >> 1) & 0x3f`）。 */
  type: number;
  /** 不含起始码的 NAL 内容（从 2 字节 NAL 头开始）。 */
  data: Uint8Array;
}

/**
 * 是否为 IRAP（随机接入点）NAL 类型。
 *
 * HEVC 里能独立解码的帧：BLA（16..18）、IDR（19/20）、CRA（21）。
 * 解码器在 `configure()` 之后必须从这里开始，否则后续 delta 帧全解不了。
 */
export function isIrapNalType(type: number): boolean {
  return (type >= 16 && type <= 21) || type === 21;
}

/** 一段 Annex B 数据里是否含 IRAP 帧。 */
function containsIrap(frameData: Uint8Array, subHeaderSize: number): boolean {
  if (subHeaderSize >= frameData.length) return false;
  for (const nal of splitHevcNals(frameData.subarray(subHeaderSize))) {
    if (isIrapNalType(nal.type)) return true;
  }
  return false;
}

const HEVC_NAMES: Record<number, string> = {
  0: 'TRAIL_N',
  1: 'TRAIL_R',
  19: 'IDR_W_RADL',
  20: 'IDR_N_LP',
  21: 'CRA',
  32: 'VPS',
  33: 'SPS',
  34: 'PPS',
  35: 'AUD',
  39: 'SEI',
};

/** NAL 类型的中文名（日志用）。 */
export function hevcNalName(type: number): string {
  return HEVC_NAMES[type] ?? `type-${type}`;
}

/**
 * 从组好的帧里取出 H.265 Annex B 裸流。
 *
 * 帧格式是 `sub-header(20B) + Annex B`。**不做解密** —— 实测两端都是明文，
 * 起始码直接可辨。返回 null 表示这段数据不是 Annex B（可能是加密的，或者
 * sub-header 长度读错了）。
 */
export function extractHevc(frame: VideoFrame): Uint8Array | null {
  if (frame.subHeaderSize >= frame.frameData.length) return null;
  const body = frame.frameData.subarray(frame.subHeaderSize);
  return hasAnnexBStartCode(body) ? body : null;
}

/** 以 4 字节或 3 字节起始码开头。 */
export function hasAnnexBStartCode(data: Uint8Array): boolean {
  if (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1) {
    return true;
  }
  return data.length >= 3 && data[0] === 0 && data[1] === 0 && data[2] === 1;
}

/** 把一个 Annex B 裸流切成 NAL 单元。 */
export function splitHevcNals(data: Uint8Array): HevcNal[] {
  const nals: HevcNal[] = [];
  let i = 0;
  let start = -1;
  while (i < data.length) {
    const four =
      i + 4 <= data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1;
    const three =
      !four && i + 3 <= data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (four || three) {
      if (start >= 0) {
        const body = data.subarray(start, i);
        if (body.length >= 2) nals.push({ type: (body[0]! >> 1) & 0x3f, data: body });
      }
      start = i + (four ? 4 : 3);
      i = start;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < data.length) {
    const body = data.subarray(start);
    if (body.length >= 2) nals.push({ type: (body[0]! >> 1) & 0x3f, data: body });
  }
  return nals;
}

// ═══════════════════════════ 构造 ═══════════════════════════

/**
 * 摄像头开关控制包（`subType=4`，空体，17 字节）。
 *
 * 实测：开和关用的是**完全相同的包**，方向靠「谁发的」区分，连发两次防丢包。
 * 也就是说协议层没有「开 / 关」的布尔位 —— 收到一条就把对端视频状态取反。
 *
 * `sessionTs` 与 `tick` 与其它媒体包同源（前者每方向恒定，后者每包递增）。
 */
export function buildVideoControl(params: { sessionTs: number; tick: number }): Uint8Array {
  const out = new Uint8Array(AUDIO_HEADER_LEN);
  out[0] = AUDIO_STX;
  writeU16be(out, 1, AUDIO_HEADER_LEN);
  out[3] = VIDEO_CTRL_SUB_TYPE;
  // seq 固定 0（实测控制包不带序号）。
  writeU32be(out, 5, 0);
  writeU32be(out, 9, params.sessionTs);
  writeU32be(out, 13, params.tick);
  return out;
}

/**
 * 视频会话保活包（`subType=5`，29 字节）。
 *
 * body 前 4 字节是固定 `02 00 00 00`，后 4 字节是 tick 的**小端**副本（实测
 * 与外层 tick 一致，字节序相反）。中间 4 字节未还原，实测恒为 0，照抄。
 */
export function buildVideoKeepalive(params: { sessionTs: number; tick: number }): Uint8Array {
  const out = new Uint8Array(AUDIO_HEADER_LEN + 12);
  out[0] = AUDIO_STX;
  writeU16be(out, 1, out.length);
  out[3] = VIDEO_KEEPALIVE_SUB_TYPE;
  writeU32be(out, 5, 0);
  writeU32be(out, 9, params.sessionTs);
  writeU32be(out, 13, params.tick);

  const body = out.subarray(AUDIO_HEADER_LEN);
  body[0] = 0x02;
  // [1:4] 实测恒为 0。
  // [4:8] tick 的小端副本。
  body[4] = params.tick & 0xff;
  body[5] = (params.tick >>> 8) & 0xff;
  body[6] = (params.tick >>> 16) & 0xff;
  body[7] = (params.tick >>> 24) & 0xff;
  // [8:12] 实测恒为 0。
  return out;
}

/**
 * 发一帧视频（把 Annex B 裸流切成 `0x5b subType=2` 分片）。
 *
 * 分片大小按实测：单个 UDP 载荷控制在 `maxPayload` 以内（默认 1200，留出
 * IPv6 / UDP 头余量）。调用方要自己把 `frameData` 前面拼上 20 字节 sub-header
 * —— 这里接收的是**已含 sub-header** 的完整帧数据，与 `VideoFrame.frameData`
 * 同形，这样收发两侧可以共用组帧逻辑做回归比对。
 *
 * `fidx` 固定 1（基础层）：实测 c2c 通话不启用时域增强层。
 */
export function buildVideoPackets(params: {
  frameData: Uint8Array;
  gidx: number;
  fidx?: number;
  sessionTs: number;
  tick: number;
  seq: number;
  subType?: number;
  maxPayload?: number;
  /** 每帧递增的 tick 偏移，调用方按包数累加。 */
  tickForPacket?: (index: number) => number;
}): Uint8Array[] {
  const fidx = params.fidx ?? 1;
  const subType = params.subType ?? VideoSubType.max;
  // `maxPayload` 是**单个 UDP 包的总长上限**，每片都要扣掉外层头 + RTP 头 + 扩展。
  const maxPacket = Math.max(64, params.maxPayload ?? 1200);
  const maxChunk = maxPacket - AUDIO_HEADER_LEN - VIDEO_RTP_HEADER_LEN - EXT_HEADER_LEN;
  const total = Math.max(1, Math.ceil(params.frameData.length / maxChunk));
  // 单个 `pkg_idx` 是 1 字节，分片数不能超 255。
  const totalPkg = Math.min(total, 255);

  const packets: Uint8Array[] = [];
  for (let i = 0; i < totalPkg; i++) {
    const start = i * maxChunk;
    const end = Math.min(start + maxChunk, params.frameData.length);
    const chunk = params.frameData.subarray(start, end);
    const bodyLen = VIDEO_RTP_HEADER_LEN + EXT_HEADER_LEN + chunk.length;
    const out = new Uint8Array(AUDIO_HEADER_LEN + bodyLen);

    out[0] = AUDIO_STX;
    writeU16be(out, 1, out.length);
    out[3] = subType;
    writeU32be(out, 5, params.seq);
    writeU32be(out, 9, params.sessionTs);
    writeU32be(out, 13, params.tickForPacket ? params.tickForPacket(i) : (params.tick + i) >>> 0);

    // RTP 头。`ext_fec_byte=0x0b` 是实测值：无跨帧 FEC、1 条 type=3 扩展。
    out[AUDIO_HEADER_LEN] = i;
    out[AUDIO_HEADER_LEN + 1] = totalPkg;
    out[AUDIO_HEADER_LEN + 2] = 0;
    out[AUDIO_HEADER_LEN + 3] = 0x0b;
    out[AUDIO_HEADER_LEN + 4] = params.gidx & 0xff;
    out[AUDIO_HEADER_LEN + 5] = fidx & 0xff;

    // 那条 type=3 扩展（`len=2, type=3`，无数据）——必须真的写出来，
    // 否则接收端按 ext 计数跳过时会把 sub-header 的前 2 字节吃掉。
    out[AUDIO_HEADER_LEN + VIDEO_RTP_HEADER_LEN] = EXT_HEADER_LEN;
    out[AUDIO_HEADER_LEN + VIDEO_RTP_HEADER_LEN + 1] = 0x03;

    out.set(chunk, AUDIO_HEADER_LEN + VIDEO_RTP_HEADER_LEN + EXT_HEADER_LEN);
    packets.push(out);
  }
  return packets;
}

/**
 * 构造 20 字节 sub-header。
 *
 * 字段位置来自实测（两端一致）：
 *
 * ```text
 * [0]      20           sub-header 长度（自己）
 * [1]      gidx & 0xff
 * [2]      03           常量
 * [3]      06           常量
 * [4:6]    00 00        常量
 * [6:8]    帧序号（大端，每帧 +1）
 * [8:12]   帧时间戳 ms（大端）
 * [12:16]  0
 * [16:20]  0（首帧另见下）
 * ```
 *
 * 首帧（`gidx=0`）的 `[2]` 是 `03`、`[3]` 是 `03`（`14000306…`），后续帧
 * `[2]` 才从 0 递增 —— 这一点实测有出入，按 gidx=0 用 `03 03`、其余用
 * `03 06` 处理（调用方可用 `variant` 覆盖）。
 */
export function buildVideoSubHeader(params: {
  gidx: number;
  frameIndex: number;
  timestampMs: number;
  /** 0 = 普通帧（`03 06`），1 = 首帧（`03 03`）。实测首帧就是 1。 */
  variant?: number;
}): Uint8Array {
  const out = new Uint8Array(20);
  out[0] = 20;
  out[1] = params.gidx & 0xff;
  out[2] = 0x03;
  out[3] = params.variant === 1 ? 0x03 : 0x06;
  writeU16be(out, 6, params.frameIndex & 0xffff);
  writeU32be(out, 8, params.timestampMs >>> 0);
  return out;
}
