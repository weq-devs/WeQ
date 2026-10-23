/**
 * 前向纠错（RS-FEC）与音频质量反馈。
 *
 * 通话的音频走 UDP，丢包是常态。客户端每 4 帧音频做一次 Reed-Solomon 编码，
 * 算出 3 行校验数据，塞进**下一组**的前 3 帧里一起发出去 —— 接收端少几帧时
 * 可以用它们把丢掉的帧恢复回来。
 *
 * 这个模块提供编码器（发送侧）与一个「够用」的解码器（接收侧：收集一组 4+3
 * 帧后恢复任意缺失的若干帧）。
 */

import {
  AUDIO_STX,
  AUDIO_HEADER_LEN,
  encodeVarint,
  pbBytes,
  pbGetBytes,
  pbGetVarint,
  pbVarint,
} from './gcs';

// ═══════════════════════════ GF(2^8) ═══════════════════════════

/** 本原多项式 0x11d（x^8 + x^4 + x^3 + x^2 + 1），与通话服务端一致。 */
const GF_POLY = 0x11d;

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGf(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= GF_POLY;
  }
  // 把指数表续到 512 项，乘法时就不必每次取模。
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function _gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('GF(2^8) 除以零');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a]! + 255 - GF_LOG[b]!) % 255]!;
}

function gfInv(a: number): number {
  if (a === 0) throw new Error('GF(2^8) 零元不可逆');
  return GF_EXP[255 - GF_LOG[a]!]!;
}

// ═══════════════════════════ Cauchy 生成矩阵 ═══════════════════════════

/** 每组数据帧数（固定）。 */
export const FEC_DATA_FRAMES = 4;
/** 每组的校验行数（固定）。 */
export const FEC_PARITY_ROWS = 3;

/**
 * Cauchy 矩阵 `M[m][n] = inv(m XOR (M + n))`。
 *
 * 选 Cauchy 而不是 Vandermonde 是因为它天然满足「任意 M 行组成的子阵可逆」，
 * 恢复任意 M 个缺失帧都不会退化。
 */
function cauchyMatrix(rows: number, cols: number): Uint8Array {
  const m = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      m[r * cols + c] = gfInv(r ^ (rows + c));
    }
  }
  return m;
}

/**
 * 编码：把 `FEC_DATA_FRAMES` 帧数据压成 `FEC_PARITY_ROWS` 行校验。
 *
 * 短帧按 0 补齐到 `frameSize`，解码端恢复出来的尾部补零会被裁掉（长度由
 * 各帧自己的帧头给出）。
 */
export function rsEncode(frames: Uint8Array[], frameSize: number): Uint8Array[] {
  if (frames.length === 0) return [];
  const matrix = cauchyMatrix(FEC_PARITY_ROWS, frames.length);
  const out: Uint8Array[] = [];
  for (let r = 0; r < FEC_PARITY_ROWS; r++) {
    const parity = new Uint8Array(frameSize);
    for (let c = 0; c < frames.length; c++) {
      const coeff = matrix[r * frames.length + c]!;
      if (coeff === 0) continue;
      const frame = frames[c]!;
      for (let b = 0; b < frameSize; b++) {
        parity[b] = parity[b]! ^ gfMul(coeff, b < frame.length ? frame[b]! : 0);
      }
    }
    out.push(parity);
  }
  return out;
}

/**
 * 解码：已知若干帧 + 若干校验行，恢复缺失帧。
 *
 * `present` 里 `null` 表示该位置的帧丢了。缺失数必须 ≤ 已有校验行数，
 * 否则返回 `null`（这组救不回来，交给上层做丢帧插值）。
 */
export function rsDecode(
  present: Array<Uint8Array | null>,
  parityRows: Array<{ row: number; data: Uint8Array }>,
  frameSize: number,
): Uint8Array[] | null {
  const missing: number[] = [];
  for (let i = 0; i < present.length; i++) if (!present[i]) missing.push(i);
  if (missing.length === 0) return present.map((f) => f!);
  if (missing.length > parityRows.length) return null;

  const matrix = cauchyMatrix(FEC_PARITY_ROWS, present.length);
  const rows = parityRows.slice(0, missing.length);
  const size = missing.length;

  // 解线性方程组：把 [A | b] 化成单位阵。
  const a: number[][] = [];
  const b: Uint8Array[] = [];
  for (let k = 0; k < size; k++) {
    a.push(missing.map((col) => matrix[rows[k]!.row * present.length + col]!));
    b.push(Uint8Array.from(rows[k]!.data));
  }

  // 先减去已知帧的贡献。
  for (let k = 0; k < size; k++) {
    for (let i = 0; i < present.length; i++) {
      const frame = present[i];
      if (!frame) continue;
      const coeff = matrix[rows[k]!.row * present.length + i]!;
      if (coeff === 0) continue;
      const target = b[k]!;
      for (let x = 0; x < frameSize; x++) {
        target[x] = target[x]! ^ gfMul(coeff, x < frame.length ? frame[x]! : 0);
      }
    }
  }

  // 高斯消元（只用行变换，GF(2^8) 上的乘除法）。
  for (let col = 0; col < size; col++) {
    let pivot = col;
    while (pivot < size && a[pivot]![col] === 0) pivot++;
    if (pivot === size) return null;
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col]!, a[pivot]!];
      [b[pivot], b[col]] = [b[col]!, b[pivot]!];
    }
    const inv = gfInv(a[col]![col]!);
    for (let j = 0; j < size; j++) a[col]![j] = gfMul(a[col]![j]!, inv);
    for (let x = 0; x < frameSize; x++) b[col]![x] = gfMul(b[col]![x]!, inv);
    for (let row = 0; row < size; row++) {
      if (row === col) continue;
      const factor = a[row]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < size; j++) a[row]![j] = a[row]![j]! ^ gfMul(factor, a[col]![j]!);
      for (let x = 0; x < frameSize; x++) b[row]![x] = b[row]![x]! ^ gfMul(factor, b[col]![x]!);
    }
  }

  const recovered = present.slice();
  for (let k = 0; k < size; k++) recovered[missing[k]!] = b[k]!;
  return recovered.map((f) => f!);
}

// ═══════════════════════════ FEC 容器 ═══════════════════════════

/**
 * 把一行校验数据包成容器，追加在音频帧尾。
 *
 * 外层 `[20 03 0E] [cnt:2] [subSeq:2] [tickHi16:16 | contentLen:16] [inner]`，
 * 内层 `[01 52 53] [paySize:2] [N] [4] [3] [fecIdx:2] [parity] [43 44] [00 00]`。
 *
 * `N` 取值 4/5/6 对应组内第 1/2/3 帧；`fecIdx` 是全组序号（跳过「锚帧」的位置）。
 */
export function buildFecContainer(params: {
  parity: Uint8Array;
  /** 上一组的帧长（校验数据的有效长度）。 */
  paySize: number;
  /** 0/1/2 —— 组内第几帧携带这份校验。 */
  rowIndex: number;
  /** 全局容器序号，从 1 起。 */
  globalCnt: number;
  /** 上一组锚帧的 tick（只取低 16 位）。 */
  groupTick: number;
  /** 全局 FEC 序号（跳过锚帧位置）。 */
  globalFecIdx: number;
  /** 会话级随机常量，服务端原样比对。 */
  fecSubSeq: number;
}): Uint8Array {
  const inner = new Uint8Array(14 + params.paySize);
  inner[0] = 0x01;
  inner[1] = 0x52;
  inner[2] = 0x53;
  inner[3] = (params.paySize >>> 8) & 0xff;
  inner[4] = params.paySize & 0xff;
  inner[5] = FEC_DATA_FRAMES + params.rowIndex;
  inner[6] = FEC_DATA_FRAMES;
  inner[7] = FEC_PARITY_ROWS;
  inner[8] = (params.globalFecIdx >>> 8) & 0xff;
  inner[9] = params.globalFecIdx & 0xff;
  inner.set(params.parity.subarray(0, params.paySize), 10);
  inner[10 + params.paySize] = 0x43;
  inner[11 + params.paySize] = 0x44;

  const contentLen = inner.length - 2;
  const outer = new Uint8Array(11 + inner.length);
  outer[0] = 0x20;
  outer[1] = 0x03;
  outer[2] = 0x0e;
  outer[3] = (params.globalCnt >>> 8) & 0xff;
  outer[4] = params.globalCnt & 0xff;
  outer[5] = (params.fecSubSeq >>> 8) & 0xff;
  outer[6] = params.fecSubSeq & 0xff;
  const subTs = (((params.groupTick & 0xffff) << 16) | (contentLen & 0xffff)) >>> 0;
  outer[7] = (subTs >>> 24) & 0xff;
  outer[8] = (subTs >>> 16) & 0xff;
  outer[9] = (subTs >>> 8) & 0xff;
  outer[10] = subTs & 0xff;
  outer.set(inner, 11);
  return outer;
}

/** 从带冗余的音频帧尾解析出 FEC 容器。 */
export interface FecContainer {
  /** 组内第几帧携带（0/1/2 → N=4/5/6）。 */
  rowIndex: number;
  paySize: number;
  fecIdx: number;
  parity: Uint8Array;
}

export function parseFecContainer(payload: Uint8Array): FecContainer | null {
  // 容器以 `20 03 0E` 开头；在一帧尾部找它。
  let start = -1;
  for (let i = 0; i + 3 <= payload.length; i++) {
    if (payload[i] === 0x20 && payload[i + 1] === 0x03 && payload[i + 2] === 0x0e) {
      start = i;
      break;
    }
  }
  if (start < 0 || start + 11 > payload.length) return null;
  const contentLen = ((payload[start + 9]! << 8) | payload[start + 10]!) & 0xffff;
  const inner = payload.subarray(start + 11, start + 11 + contentLen);
  if (inner.length < 10) return null;
  if (inner[0] !== 0x01 || inner[1] !== 0x52 || inner[2] !== 0x53) return null;
  const paySize = (inner[3]! << 8) | inner[4]!;
  const rowIndex = inner[5]! - FEC_DATA_FRAMES;
  if (rowIndex < 0 || rowIndex >= FEC_PARITY_ROWS) return null;
  if (inner.length < 10 + paySize) return null;
  return {
    rowIndex,
    paySize,
    fecIdx: (inner[8]! << 8) | inner[9]!,
    parity: inner.subarray(10, 10 + paySize),
  };
}

// ═══════════════════════════ FEC 控制包 ═══════════════════════════

/**
 * FEC 带宽探测控制包（`subType=14`）。
 *
 * 每组音频结束后发一对（大包 + 小包），服务端据此估计链路余量。`large=false`
 * 是小包（只带 tick），`large=true` 额外带收发计数。
 */
export function buildFecCtrlPacket(params: {
  seq: number;
  sessionTs: number;
  tick: number;
  large: boolean;
  /** 大包里的计数器，一般按序号推。 */
  counter?: number;
}): Uint8Array {
  const type = params.large ? 1 : 2;
  const f1 = Uint8Array.from([0x0a, 0x04, 0x08, params.seq & 0xff, 0x10, type]);

  let f2: Uint8Array;
  if (!params.large) {
    const tickVarint = encodeVarint(params.tick);
    // f2 内层固定 17 字节：f1=tick，f2(17B)=一段带宽描述。
    const inner = concat([
      Uint8Array.from([0x08]),
      tickVarint,
      Uint8Array.from([0x12, 0x11, 0x08, 0x00, 0x10, 0x00, 0x18, 0x00, 0x28]),
      // 9 字节的超大 varint，作为带宽上限占位。
      Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0xff, 0x01]),
    ]);
    f2 = new Uint8Array(2 + inner.length);
    f2[0] = 0x12;
    f2[1] = inner.length & 0xff;
    f2.set(inner, 2);
  } else {
    const counter = params.counter ?? params.seq * 10 + 10;
    const parts: Uint8Array[] = [];
    parts.push(pbVarint(3, params.seq));
    parts.push(pbVarint(4, 100));
    parts.push(pbVarint(5, counter));
    parts.push(pbVarint(6, counter));
    parts.push(Uint8Array.from([0x38, 0x00, 0x48, 0x00, 0x50, 0x00]));
    parts.push(Uint8Array.from([0x68, 0x00, 0x70, 0x00, 0x78, 0x00]));
    const tail = concat(parts);
    const tickVarint = encodeVarint(params.tick);
    const inner = concat([
      Uint8Array.from([0x08]),
      tickVarint,
      Uint8Array.from([0x10]),
      tickVarint,
      tail,
    ]);
    f2 = concat([Uint8Array.from([0x0a, inner.length & 0xff]), inner]);
  }

  const body = concat([f1, f2]);
  const out = new Uint8Array(AUDIO_HEADER_LEN + body.length);
  out[0] = AUDIO_STX;
  out[1] = ((AUDIO_HEADER_LEN + body.length) >>> 8) & 0xff;
  out[2] = (AUDIO_HEADER_LEN + body.length) & 0xff;
  out[3] = 0x0e;
  writeU32beLocal(out, 5, params.seq);
  writeU32beLocal(out, 9, params.sessionTs);
  writeU32beLocal(out, 13, params.tick);
  out.set(body, AUDIO_HEADER_LEN);
  return out;
}

function writeU32beLocal(buf: Uint8Array, off: number, value: number): void {
  buf[off] = (value >>> 24) & 0xff;
  buf[off + 1] = (value >>> 16) & 0xff;
  buf[off + 2] = (value >>> 8) & 0xff;
  buf[off + 3] = value & 0xff;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ═══════════════════════════ 质量反馈（QFB） ═══════════════════════════

/**
 * 质量反馈请求（`subType=14` 之外的另一条 `subType=0x0e`，靠 `type` 区分）。
 *
 * 每 2 秒发一次，报接收质量。前 5 次不带音频接收统计，第 6 次起带 —— 带上
 * `penguinsDecState=2` 之后对端才把编码从 SILK 切到 Opus。**这是能让对端用
 * Opus 发语音的前提**，不是可选优化。
 */
export function buildQfbRequest(params: {
  seq: number;
  sessionTs: number;
  tick: number;
  qfbSeq: number;
  /** 上一周期收到的最后一个 tick。 */
  tsStart: number;
  recvPercent?: number;
  jitterMs?: number;
  bandwidth?: number;
  /** Penguins 能力哈希，与初始化帧里的一致。 */
  capabilityHash?: number;
}): Uint8Array {
  const withAudio = params.qfbSeq >= 6;

  // stats（body.f1）
  const stats: Uint8Array[] = [
    pbVarint(1, params.tsStart),
    pbVarint(2, params.tick),
    pbVarint(3, params.qfbSeq),
    pbVarint(4, params.recvPercent ?? 100),
    pbVarint(5, params.jitterMs ?? 5),
    pbVarint(6, params.jitterMs ?? 5),
    pbVarint(7, withAudio ? 120 : 0),
    ...(withAudio
      ? [
          pbBytes(
            8,
            concat([
              pbVarint(5, 120), // 抖动
              pbVarint(6, 120), // 估计抖动
              pbVarint(7, 20),
              pbVarint(9, 2000), // 估计带宽
              pbVarint(10, 500),
              pbVarint(15, BigInt(params.capabilityHash ?? 0x61afe68f)),
              pbVarint(16, 2), // 支持解码 Opus
            ]),
          ),
        ]
      : []),
    pbVarint(9, withAudio ? 2000 : 0),
    pbVarint(10, withAudio ? 2 : 0),
    pbVarint(12, params.tick),
    pbVarint(13, 0),
    pbVarint(14, 0),
    pbVarint(15, 0),
  ];

  const body = concat([
    pbBytes(1, concat([pbVarint(1, params.qfbSeq), pbVarint(2, 1)])),
    pbBytes(2, concat([pbBytes(1, concat(stats))])),
  ]);
  return wrapQfb(params.seq, params.sessionTs, params.tick, body);
}

/** 质量反馈应答：回显对端的请求序号与时间戳。 */
export function buildQfbResponse(params: {
  seq: number;
  sessionTs: number;
  tick: number;
  qfbSeq: number;
  echoTs: number;
}): Uint8Array {
  const body = concat([
    pbBytes(1, concat([pbVarint(1, params.qfbSeq), pbVarint(2, 2)])),
    pbBytes(
      2,
      concat([
        pbBytes(
          2,
          concat([
            pbVarint(1, params.echoTs),
            pbBytes(2, concat([pbVarint(1, 0), pbVarint(2, 0), pbVarint(3, 0)])),
          ]),
        ),
      ]),
    ),
  ]);
  return wrapQfb(params.seq, params.sessionTs, params.tick, body);
}

function wrapQfb(seq: number, sessionTs: number, tick: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(AUDIO_HEADER_LEN + body.length);
  out[0] = AUDIO_STX;
  out[1] = ((AUDIO_HEADER_LEN + body.length) >>> 8) & 0xff;
  out[2] = (AUDIO_HEADER_LEN + body.length) & 0xff;
  out[3] = 0x0e;
  writeU32beLocal(out, 5, seq);
  writeU32beLocal(out, 9, sessionTs);
  writeU32beLocal(out, 13, tick);
  out.set(body, AUDIO_HEADER_LEN);
  return out;
}

/** 解析质量反馈。 */
export interface QfbPacket {
  qfbSeq: number;
  /** 1 = 请求，2 = 应答。 */
  type: number;
  echoTs?: number;
}

export function parseQfb(payload: Uint8Array): QfbPacket | null {
  const header = pbGetBytes(payload, 1);
  if (!header) return null;
  const qfbSeq = pbGetVarint(header, 1);
  const type = pbGetVarint(header, 2);
  if (qfbSeq === undefined || type === undefined) return null;
  const result: QfbPacket = { qfbSeq, type };
  if (type === 2) {
    const bodyField = pbGetBytes(payload, 2);
    const ack = bodyField ? pbGetBytes(bodyField, 2) : undefined;
    const echoTs = ack ? pbGetVarint(ack, 1) : undefined;
    if (echoTs !== undefined) result.echoTs = echoTs;
  }
  return result;
}
