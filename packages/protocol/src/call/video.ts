/**
 * 视频通话的媒体层：视频帧（`0x5b subType=2/3/7`）与摄像头开关控制包（`subType=4`）。
 *
 * 与音频共用 17 字节外层头（`0x5b`），但载荷是另一套结构：外层头之后是 6 字节
 * 视频 RTP 头 + 可选扩展段 + 加密无关的明文 H.265 Annex B。
 *
 * 实测（2026-10-25，一次 21 秒的真实双向视频通话，21.4 万帧样本）确认的格式：
 *
 * ```text
 * 0x5b 头 17B        [3]=subType  [5:9]=seq  [9:13]=sessionTs  [13:17]=tick
 *   ↓
 * 视频 RTP 头 6B     pkg_idx | total_pkg | total_fec | ext_fec_byte | gidx | fidx
 *   ↓
 * 扩展段 3B          03 03 00（len=3 含自身、type=3、data 1 字节）
 *   ↓ （同一帧的各分片按 pkg_idx 拼起来）
 * sub-header 20B     [0]=20  [1]=帧序号  [2]=方向  [3]=06  [8:12]=时间戳
 *   ↓
 * H.265 Annex B      以 00 00 00 01 起始码开头，**明文**
 * ```
 *
 * 三个容易写错的地方（都是对着抓包逐字节比对出来的）：
 *
 * 1. **扩展段是 3 字节**，不是 2 字节。少 1 字节接收端整体错位。
 * 2. **`seq` 每片 +1**（整通连续递增、不按帧重置）；**外层 `tick` 帧内恒定**。
 *    两者写反过 —— 那样对端的重排 / 去重判定会失效。
 * 3. **sub-header `[2]` 是方向标识**（c2s=0x00 / s2c=0x03），且时间戳布局随之
 *    变化。恒写 0x03 等于把自己伪装成对端方向。
 *
 * 帧的归属靠 `(gidx, fidx)`：`fidx=1` 是基础层（可独立解码），`fidx>=2` 是时域
 * 增强层（依赖基础层，跳过可避免花屏）。同一个 GOP 内 `gidx` 递增。
 *
 * `[9:13]` 两侧都是**每方向恒定的会话时钟**（实测 c2s/s2c 各差 1），不是每包
 * 变化的时间戳。真正的帧时间戳在 sub-header 里。
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
 * 每个视频包都带的那条扩展：`[len][type][data]`，len=3 含自身，type=3，data 1 字节 `0x00`。
 *
 * 实测真实客户端在 `ext_fec_byte` 低位写 `0x0b`（= 11 → 1 条扩展），扩展体是
 * `03 03 00` —— **3 字节**，不是 2 字节。少写那 1 字节，接收端按 `dataOffset`
 * 取载荷就会整体前移，sub-header 与后面的 Annex B 起始码全对不上。
 */
export const VIDEO_EXT_LEN = 3;

/** 那条扩展的 type（实测恒为 3）。 */
export const VIDEO_EXT_TYPE = 3;

/** 扩展段的 data 部分（1 字节 0x00，实测恒定）。 */
const VIDEO_EXT_DATA = 0x00;

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
 * 实测真实客户端每 2 秒发**两条**，body 首字节区分变体，两条间隔 40–90 ms：
 *
 * ```text
 * body[0] = 0x02   body[4:8] = 自己 tick 的小端    body[8:12] = 0
 * body[0] = 0x03   body[4:8] = 对端最新 tick 的小端  body[8:12] = 自己 tick 的小端
 * ```
 *
 * `0x03` 那条相当于「我收到你发到某个 tick 了」的回执，对端据此判断直连是否通。
 * body[1:4] 实测恒为 0，照抄。
 */
export function buildVideoKeepalive(params: {
  sessionTs: number;
  tick: number;
  /** 变体：0x02 = 只报自己；0x03 = 附带对端最新 tick。 */
  variant?: 0x02 | 0x03;
  /** 对端最近一个包的 tick（`variant=0x03` 时写进 body[4:8]）。 */
  peerTick?: number;
}): Uint8Array {
  const variant = params.variant ?? 0x02;
  const out = new Uint8Array(AUDIO_HEADER_LEN + 12);
  out[0] = AUDIO_STX;
  writeU16be(out, 1, out.length);
  out[3] = VIDEO_KEEPALIVE_SUB_TYPE;
  writeU32be(out, 5, 0);
  writeU32be(out, 9, params.sessionTs);
  writeU32be(out, 13, params.tick);

  const body = out.subarray(AUDIO_HEADER_LEN);
  body[0] = variant;
  // [1:4] 实测恒为 0。
  writeU32le(body, 4, variant === 0x03 ? (params.peerTick ?? 0) : params.tick);
  writeU32le(body, 8, variant === 0x03 ? params.tick : 0);
  return out;
}

/** 小端 32 位写入（保活包的 body 是反字节序的）。 */
function writeU32le(buf: Uint8Array, off: number, value: number): void {
  buf[off] = value & 0xff;
  buf[off + 1] = (value >>> 8) & 0xff;
  buf[off + 2] = (value >>> 16) & 0xff;
  buf[off + 3] = (value >>> 24) & 0xff;
}

/**
 * 一帧会被切成几片。
 *
 * 发送侧要提前把片数写进 sub-header `[16:20]`，所以单独抽出来；`buildVideoPackets`
 * 内部也用它，两边不会漂移。
 */
export function videoPacketCount(frameBytes: number, maxPayload = 1200): number {
  // `maxPayload` 是**单个 UDP 包的总长上限**，每片都要扣掉外层头 + RTP 头 + 扩展。
  const maxPacket = Math.max(64, maxPayload);
  const maxChunk = maxPacket - AUDIO_HEADER_LEN - VIDEO_RTP_HEADER_LEN - VIDEO_EXT_LEN;
  const total = Math.max(1, Math.ceil(frameBytes / maxChunk));
  // 单个 `pkg_idx` 是 1 字节，分片数不能超 255。
  return Math.min(total, 255);
}

/**
 * 发一帧视频（把 Annex B 裸流切成 `0x5b subType=2` 分片）。
 *
 * 分片规则按实测：
 *
 * - 单个 UDP 包总长不超过 `maxPayload`（默认 1200，留出 IPv6 / UDP 头余量）；
 * - **整帧等分**：`chunkSize = ceil(len / total)`，末片自然短；
 * - **`seq` 每片 +1**（真实抓包里 21 秒连续 0…717，不分帧重置）；
 * - **外层 `tick` 帧内恒定**，每帧换一次。
 *
 * 调用方要自己把 `frameData` 前面拼上 20 字节 sub-header —— 这里接收的是
 * **已含 sub-header** 的完整帧数据，与 `VideoFrame.frameData` 同形，这样收发
 * 两侧可以共用组帧逻辑做回归比对。
 *
 * `fidx` 固定 1（基础层）：实测 c2c 通话不启用时域增强层。
 */
export function buildVideoPackets(params: {
  frameData: Uint8Array;
  gidx: number;
  fidx?: number;
  sessionTs: number;
  /** 本帧所有分片共用的 tick。 */
  tick: number;
  /** 本帧第一个分片的 seq，内部按片递增。 */
  seq: number;
  subType?: number;
  maxPayload?: number;
  /** 覆盖单片的 tick（调试用；默认所有分片相同）。 */
  tickForPacket?: (index: number) => number;
}): Uint8Array[] {
  const fidx = params.fidx ?? 1;
  const subType = params.subType ?? VideoSubType.max;
  const totalPkg = videoPacketCount(params.frameData.length, params.maxPayload);
  // 等分：末片自然短。真实客户端的末片不带 0 填充（填充语义未经证实，不补）。
  const chunkSize = Math.max(1, Math.ceil(params.frameData.length / totalPkg));

  const packets: Uint8Array[] = [];
  for (let i = 0; i < totalPkg; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, params.frameData.length);
    const chunk = params.frameData.subarray(start, end);
    const bodyLen = VIDEO_RTP_HEADER_LEN + VIDEO_EXT_LEN + chunk.length;
    const out = new Uint8Array(AUDIO_HEADER_LEN + bodyLen);

    out[0] = AUDIO_STX;
    writeU16be(out, 1, out.length);
    out[3] = subType;
    writeU32be(out, 5, (params.seq + i) >>> 0);
    writeU32be(out, 9, params.sessionTs);
    writeU32be(out, 13, params.tickForPacket ? params.tickForPacket(i) : params.tick >>> 0);

    // RTP 头。`ext_fec_byte=0x0b` 是实测值：无跨帧 FEC、1 条 type=3 扩展。
    out[AUDIO_HEADER_LEN] = i;
    out[AUDIO_HEADER_LEN + 1] = totalPkg;
    out[AUDIO_HEADER_LEN + 2] = 0;
    out[AUDIO_HEADER_LEN + 3] = 0x0b;
    out[AUDIO_HEADER_LEN + 4] = params.gidx & 0xff;
    out[AUDIO_HEADER_LEN + 5] = fidx & 0xff;

    // 那条扩展 `03 03 00`（len=3 含自身、type=3、data 1 字节）——必须完整写出来，
    // 少 1 字节接收端按 len 跳过时会把 sub-header 整体前移。
    const extAt = AUDIO_HEADER_LEN + VIDEO_RTP_HEADER_LEN;
    out[extAt] = VIDEO_EXT_LEN;
    out[extAt + 1] = VIDEO_EXT_TYPE;
    out[extAt + 2] = VIDEO_EXT_DATA;

    out.set(chunk, extAt + VIDEO_EXT_LEN);
    packets.push(out);
  }
  return packets;
}

/**
 * sub-header 的 `[2]` 字节：方向标识，两侧取值不同。
 *
 * | 方向 | `[2]` | `[8:12]` | `[12:16]` |
 * | --- | --- | --- | --- |
 * | c2s | `0x00` | 帧 PTS（相对会话起点 ms） | 会话基准 tick（恒定） |
 * | s2c | `0x03` | 发送方 tick（每帧变） | 0 |
 *
 * 这个字节不能照抄对端那一侧的值 —— 早期实现恒写 `0x03`，等于把 s2c 的格式
 * 用在了自己的上行里。
 */
export const VIDEO_SUBHEADER_DIRECTION = { c2s: 0x00, s2c: 0x03 } as const;

/** sub-header 固定长度（首字节就是它）。 */
export const VIDEO_SUBHEADER_LEN = 20;

/**
 * 构造 20 字节 sub-header。
 *
 * 实测布局（2026-10-25 双向抓包）：
 *
 * ```text
 * [0]      20                  sub-header 长度（自己）
 * [1]      帧序号 & 0xff
 * [2]      c2s=0x00 / s2c=0x03 方向标识
 * [3]      0x06                常量（**首帧也是 06**，早期「首帧 03」是误判）
 * [4:6]    00 00               常量
 * [6:8]    帧质量 + 码率档     = GetVideoFrameQuality() 的 16 位返回值
 * [8:12]   帧时间戳（见上表，随方向变）
 * [12:16]  会话基准 tick（c2s）/ 0（s2c）
 * [16:20]  帧内分片序号相关（实测 0–4 的小整数，不随发送方变化）
 * ```
 *
 * `[6:8]` 来自 `VideoPacketWriter::PackRTPEx`：
 *
 * ```c
 * *((DWORD *)v41 + 1) = bswap(a15 & (v54 ? 0xFFFF : 0xFF));
 * ```
 *
 * `a15` 是 `GetVideoFrameQuality()` 的返回值 —— **高字节 = 估算码率档，低字节 =
 * 帧质量**。抓包实测：`[6]` 落在 16–25（集中在 22–24），`[7]` 落在 31–38
 * （集中在 36）。关键帧因为量化更粗，两个值都会掉一档。
 */
export function buildVideoSubHeader(params: {
  /** 发送方向：决定 `[2]` 与时间戳布局。 */
  direction: 'c2s' | 's2c';
  /** 本会话内第几帧（从 0 起），只取低 8 位。 */
  frameIndex: number;
  /** `[8:12]`：c2s 填帧 PTS（ms），s2c 填发送时的 tick。 */
  timestampMs: number;
  /** `[12:16]`：c2s 填会话基准 tick；s2c 恒 0。 */
  baseTick?: number;
  /** `[6:8]`：`{ hi, lo }` 分别写进 `[6]` 和 `[7]`。缺省时填 0。 */
  quality?: VideoFrameQuality;
  /** `[16:20]`：帧内分片序号（实测上限很小），缺省 0。 */
  fragment?: number;
}): Uint8Array {
  const out = new Uint8Array(VIDEO_SUBHEADER_LEN);
  out[0] = VIDEO_SUBHEADER_LEN;
  out[1] = params.frameIndex & 0xff;
  out[2] = VIDEO_SUBHEADER_DIRECTION[params.direction];
  out[3] = 0x06;
  // [4:6] 恒 0。
  out[6] = (params.quality?.rateTier ?? 0) & 0xff;
  out[7] = (params.quality?.frameQuality ?? 0) & 0xff;
  writeU32be(out, 8, params.timestampMs >>> 0);
  if (params.direction === 'c2s') writeU32be(out, 12, (params.baseTick ?? 0) >>> 0);
  // [16:20] 小端。
  const frag = (params.fragment ?? 0) >>> 0;
  out[16] = frag & 0xff;
  out[17] = (frag >>> 8) & 0xff;
  out[18] = (frag >>> 16) & 0xff;
  out[19] = (frag >>> 24) & 0xff;
  return out;
}

/**
 * `[6:8]` 那两个字节：码率档 + 帧质量。
 *
 * 真实值由 QQ 的 `GetVideoFrameQuality()` 按帧计算（入参是 QP、帧大小、分辨率、
 * 帧类型）。我们拿不到编码器的 QP，改用**按真实分布抽样**生成 —— 对端只拿它做
 * 统计，不参与解码，所以分布对得上就够了。
 */
export interface VideoFrameQuality {
  /** `[6]`：估算码率档。实测 16–25，集中 22–24。 */
  rateTier: number;
  /** `[7]`：帧质量。实测 31–38，集中 36。 */
  frameQuality: number;
}

/** `[6]` 的实测分布（加权抽样用）。 */
const RATE_TIER_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [19, 5],
  [21, 6],
  [22, 20],
  [23, 36],
  [24, 22],
  [25, 7],
  [17, 2],
  [18, 2],
];

/** `[7]` 的实测分布。关键帧整体低一档。 */
const FRAME_QUALITY_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [34, 5],
  [35, 6],
  [36, 55],
  [37, 16],
  [38, 13],
  [32, 2],
  [31, 1],
];

function pickWeighted(samples: ReadonlyArray<readonly [number, number]>): number {
  const total = samples.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [value, weight] of samples) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return samples[0]![0];
}

/**
 * 抽一组 `[6:8]`。
 *
 * `keyframe` 时整体降一档 —— 实测关键帧是 `17/32`，普通帧是 `25/38`。
 */
export function sampleVideoFrameQuality(keyframe = false): VideoFrameQuality {
  const rateTier = pickWeighted(RATE_TIER_SAMPLES);
  const frameQuality = pickWeighted(FRAME_QUALITY_SAMPLES);
  if (!keyframe) return { rateTier, frameQuality };
  // I 帧量化更粗：两个值都往下压 7~8。
  return {
    rateTier: Math.max(16, rateTier - 8),
    frameQuality: Math.max(28, frameQuality - 6),
  };
}
