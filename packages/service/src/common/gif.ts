/**
 * 极简 GIF89a 编码器 + PNG / APNG 解码辅助 —— 供导出装扮阶段把「逐帧 PNG 碎片」
 * 合成一张可直接使用的动画 GIF。
 *
 * 编码器要点：
 *   - 逐帧本地调色板（GIF 每帧自带 LCT），median-cut 量化到 ≤255 色 + 1 个透明位；
 *   - 标准 GIF LZW 压缩（LSB-first 位打包 + 255 字节 sub-block）；
 *   - NETSCAPE2.0 循环扩展（loop=0 视为无限循环）。
 *
 * APNG 解码只用于老式气泡的 `animation-all.png`（legacy 路径，见 bubble_skin 模块头）：
 * 浏览器不会在 CSS border-image 里播 APNG，必须拆成帧序列再走上面的 GIF 编码器。
 */

import { PNG } from 'pngjs';

/** 一帧 RGBA 图像（8-bit，无抖动）。 */
export interface RgbaFrame {
  data: Buffer;
  width: number;
  height: number;
  delayMs: number;
}

export interface GifEncodeOptions {
  /** 循环次数；0 = 无限循环（GIF 惯例）。默认 0。 */
  loop?: number;
}

// ─────────────────────────── GIF 编码 ───────────────────────────

interface Quantized {
  /** RGB 三元组，长度为 colorCount*3。 */
  rgb: number[];
  /** 每像素的调色板下标；透明像素统一写 transparentIndex。 */
  idx: Uint8Array;
  hasAlpha: boolean;
  transparentIndex: number;
}

/** 逐帧量化：收集不透明像素 → ≤255 色 + 1 个透明位。 */
function quantize(data: Buffer, w: number, h: number): Quantized {
  const n = w * h;
  const counts = new Map<number, number>();
  let hasAlpha = false;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = data[o + 3]!;
    if (a < 128) {
      hasAlpha = true;
      continue;
    }
    const key = (data[o]! << 16) | (data[o + 1]! << 8) | data[o + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const colors = [...counts.entries()].map(([key, count]) => ({
    r: (key >>> 16) & 0xff,
    g: (key >>> 8) & 0xff,
    b: key & 0xff,
    count,
  }));

  let rgb: number[];
  let lookup: Map<number, number>;
  if (colors.length === 0) {
    rgb = [0, 0, 0];
    lookup = new Map();
  } else if (colors.length <= 255) {
    rgb = [];
    lookup = new Map();
    colors.forEach((c, i) => {
      rgb.push(c.r, c.g, c.b);
      lookup.set((c.r << 16) | (c.g << 8) | c.b, i);
    });
  } else {
    const buckets = medianCut(colors, 255);
    rgb = [];
    lookup = new Map();
    buckets.forEach((bucket, i) => {
      const [r, g, b] = averageColor(bucket);
      rgb.push(r, g, b);
      for (const c of bucket) lookup.set((c.r << 16) | (c.g << 8) | c.b, i);
    });
  }

  const transparentIndex = rgb.length / 3;
  const idx = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = data[o + 3]!;
    if (a < 128) {
      idx[i] = transparentIndex;
      continue;
    }
    const key = (data[o]! << 16) | (data[o + 1]! << 8) | data[o + 2]!;
    let c = lookup.get(key);
    if (c === undefined) {
      // 量化后理论上每种颜色都在 lookup 里；兜底找最近色。
      c = nearestColor(rgb, key);
      lookup.set(key, c);
    }
    idx[i] = c;
  }
  return { rgb, idx, hasAlpha, transparentIndex };
}

function channelRange(bucket: Array<{ r: number; g: number; b: number }>): number {
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  for (const c of bucket) {
    if (c.r < minR) minR = c.r;
    if (c.r > maxR) maxR = c.r;
    if (c.g < minG) minG = c.g;
    if (c.g > maxG) maxG = c.g;
    if (c.b < minB) minB = c.b;
    if (c.b > maxB) maxB = c.b;
  }
  return Math.max(maxR - minR, maxG - minG, maxB - minB);
}

function dominantChannel(bucket: Array<{ r: number; g: number; b: number }>): 'r' | 'g' | 'b' {
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  for (const c of bucket) {
    if (c.r < minR) minR = c.r;
    if (c.r > maxR) maxR = c.r;
    if (c.g < minG) minG = c.g;
    if (c.g > maxG) maxG = c.g;
    if (c.b < minB) minB = c.b;
    if (c.b > maxB) maxB = c.b;
  }
  const dr = maxR - minR;
  const dg = maxG - minG;
  const db = maxB - minB;
  return dr >= dg && dr >= db ? 'r' : dg >= db ? 'g' : 'b';
}

function medianCut(
  colors: Array<{ r: number; g: number; b: number; count: number }>,
  maxBuckets: number,
): Array<Array<{ r: number; g: number; b: number; count: number }>> {
  const buckets = [colors];
  while (buckets.length < maxBuckets) {
    let bi = -1;
    let best = -1;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]!;
      if (b.length < 2) continue;
      const range = channelRange(b);
      if (range > best) {
        best = range;
        bi = i;
      }
    }
    if (bi < 0) break;
    const bucket = buckets[bi]!;
    const ch = dominantChannel(bucket);
    const sorted = [...bucket].sort((a, b) => a[ch] - b[ch]);
    let total = 0;
    for (const c of sorted) total += c.count;
    let acc = 0;
    let mid = 0;
    for (; mid < sorted.length - 1; mid++) {
      acc += sorted[mid]!.count;
      if (acc >= total / 2) break;
    }
    buckets.splice(bi, 1, sorted.slice(0, mid + 1), sorted.slice(mid + 1));
  }
  return buckets;
}

function averageColor(
  bucket: Array<{ r: number; g: number; b: number; count: number }>,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const c of bucket) {
    r += c.r * c.count;
    g += c.g * c.count;
    b += c.b * c.count;
    n += c.count;
  }
  if (n === 0) return [0, 0, 0];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function nearestColor(rgb: number[], key: number): number {
  const r = (key >>> 16) & 0xff;
  const g = (key >>> 8) & 0xff;
  const b = key & 0xff;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < rgb.length; i += 3) {
    const dr = rgb[i]! - r;
    const dg = rgb[i + 1]! - g;
    const db = rgb[i + 2]! - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i / 3;
    }
  }
  return best;
}

/**
 * GIF LZW 压缩（LSB-first）。字典满时发 clear 码重置；码宽在 nextCode 撞到
 * 2^codeSize 时 +1 —— 与解码端（GIF 规范）约定一致。
 */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Buffer {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  const dict = new Map<number, number>();
  let nextCode = endCode + 1;

  const bytes: number[] = [];
  let bitBuf = 0;
  let bitCnt = 0;
  const emit = (code: number): void => {
    bitBuf |= code << bitCnt;
    bitCnt += codeSize;
    while (bitCnt >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCnt -= 8;
    }
  };
  const resetDict = (): void => {
    dict.clear();
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  };

  emit(clearCode);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = prefix * 256 + k;
    const existing = dict.get(key);
    if (existing !== undefined) {
      prefix = existing;
    } else {
      emit(prefix);
      if (nextCode < 4096) {
        dict.set(key, nextCode);
        nextCode += 1;
        if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
      } else {
        emit(clearCode);
        resetDict();
      }
      prefix = k;
    }
  }
  emit(prefix);
  emit(endCode);
  if (bitCnt > 0) bytes.push(bitBuf & 0xff);
  return Buffer.from(bytes);
}

function writeSubBlocks(out: number[], data: Buffer): void {
  let pos = 0;
  while (pos < data.length) {
    const len = Math.min(255, data.length - pos);
    out.push(len);
    for (let i = 0; i < len; i++) out.push(data[pos + i]!);
    pos += len;
  }
  out.push(0);
}

/** 多帧 RGBA → 动画 GIF 字节。所有帧统一按第一帧的画布尺寸输出。 */
export function encodeGif(frames: RgbaFrame[], opts: GifEncodeOptions = {}): Buffer {
  if (frames.length === 0) throw new Error('encodeGif: no frames');
  const canvasW = frames[0]!.width;
  const canvasH = frames[0]!.height;
  const loop = opts.loop ?? 0;

  const out: number[] = [];
  const pushStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  };
  const pushU16 = (v: number): void => {
    out.push(v & 0xff, (v >>> 8) & 0xff);
  };

  pushStr('GIF89a');
  pushU16(canvasW);
  pushU16(canvasH);
  out.push(0xf0, 0, 0); // GCT flag=0, color resolution 8bit, bg=0, aspect=0

  // NETSCAPE2.0 循环扩展。
  out.push(0x21, 0xff, 0x0b);
  pushStr('NETSCAPE2.0');
  out.push(0x03, 0x01);
  pushU16(loop);
  out.push(0x00);

  for (const frame of frames) {
    const data =
      frame.width === canvasW && frame.height === canvasH
        ? frame.data
        : fitToCanvas(frame.data, frame.width, frame.height, canvasW, canvasH);
    const { rgb, idx, hasAlpha, transparentIndex } = quantize(data, canvasW, canvasH);
    const colorCount = rgb.length / 3;
    const numEntries = hasAlpha ? colorCount + 1 : colorCount;
    const tableSizeBits = Math.max(0, Math.ceil(Math.log2(Math.max(numEntries, 2))) - 1);
    const tableEntries = 1 << (tableSizeBits + 1);
    const minCodeSize = Math.max(2, Math.ceil(Math.log2(Math.max(numEntries, 2))));
    const delayCs = Math.max(1, Math.round(frame.delayMs / 10));

    // Graphic Control Extension：disposal=2（整帧替换）+ 透明标志。
    out.push(0x21, 0xf9, 0x04, (2 << 2) | (hasAlpha ? 1 : 0));
    pushU16(delayCs);
    out.push(hasAlpha ? transparentIndex : 0, 0x00);

    // Image Descriptor + 本地调色板。
    out.push(0x2c);
    pushU16(0);
    pushU16(0);
    pushU16(canvasW);
    pushU16(canvasH);
    out.push(0x80 | tableSizeBits);
    for (let i = 0; i < tableEntries * 3; i++) out.push(rgb[i] ?? 0);

    out.push(minCodeSize);
    writeSubBlocks(out, lzwEncode(idx, minCodeSize));
  }

  out.push(0x3b);
  return Buffer.from(out);
}

/** 把子图居中放进画布（透明填充）。比画布大的部分会被裁掉。 */
export function fitToCanvas(src: Buffer, sw: number, sh: number, dw: number, dh: number): Buffer {
  const out = Buffer.alloc(dw * dh * 4);
  const ox = Math.max(0, Math.floor((dw - sw) / 2));
  const oy = Math.max(0, Math.floor((dh - sh) / 2));
  const copyW = Math.min(sw, dw - ox);
  const copyH = Math.min(sh, dh - oy);
  for (let y = 0; y < copyH; y++) {
    for (let x = 0; x < copyW; x++) {
      const si = (y * sw + x) * 4;
      const di = ((y + oy) * dw + x + ox) * 4;
      out[di] = src[si]!;
      out[di + 1] = src[si + 1]!;
      out[di + 2] = src[si + 2]!;
      out[di + 3] = src[si + 3]!;
    }
  }
  return out;
}

// ─────────────────────────── PNG / APNG 解码 ───────────────────────────

/** 单张 PNG → RGBA 帧。 */
export function pngToRgba(buf: Buffer, delayMs = 0): RgbaFrame {
  const png = PNG.sync.read(buf);
  return { data: Buffer.from(png.data), width: png.width, height: png.height, delayMs };
}

/**
 * alpha 合成：把 overlay（overlayW×overlayH）画到 base（bw×bh）的 (ox, oy) 处。
 * base 原地修改。
 */
export function compositeRgba(
  base: Buffer,
  bw: number,
  bh: number,
  overlay: Buffer,
  overlayW: number,
  overlayH: number,
  ox: number,
  oy: number,
): void {
  for (let y = 0; y < overlayH; y++) {
    const cy = oy + y;
    if (cy < 0 || cy >= bh) continue;
    for (let x = 0; x < overlayW; x++) {
      const cx = ox + x;
      if (cx < 0 || cx >= bw) continue;
      const si = (y * overlayW + x) * 4;
      const di = (cy * bw + cx) * 4;
      const sa = overlay[si + 3]!;
      if (sa === 0) continue;
      if (sa === 255) {
        base[di] = overlay[si]!;
        base[di + 1] = overlay[si + 1]!;
        base[di + 2] = overlay[si + 2]!;
        base[di + 3] = 255;
        continue;
      }
      const da = base[di + 3]!;
      const oa = sa + (da * (255 - sa)) / 255;
      if (oa === 0) continue;
      base[di] = Math.round((overlay[si]! * sa + (base[di]! * da * (255 - sa)) / 255) / oa);
      base[di + 1] = Math.round(
        (overlay[si + 1]! * sa + (base[di + 1]! * da * (255 - sa)) / 255) / oa,
      );
      base[di + 2] = Math.round(
        (overlay[si + 2]! * sa + (base[di + 2]! * da * (255 - sa)) / 255) / oa,
      );
      base[di + 3] = Math.round(oa);
    }
  }
}

// ── PNG chunk 工具（APNG 拆帧用） ──

interface PngChunk {
  type: string;
  data: Buffer;
}

function parsePngChunks(buf: Buffer): PngChunk[] | null {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const chunks: PngChunk[] = [];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    if (pos + 12 + len > buf.length) return null;
    chunks.push({
      type: buf.toString('latin1', pos + 4, pos + 8),
      data: buf.subarray(pos + 8, pos + 8 + len),
    });
    pos += 12 + len;
    if (chunks[chunks.length - 1]!.type === 'IEND') break;
  }
  return chunks;
}

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

interface FcTlInfo {
  seq: number;
  width: number;
  height: number;
  x: number;
  y: number;
  delayMs: number;
  disposeOp: number;
  blendOp: number;
}

/**
 * APNG → 帧序列。非 APNG（无 acTL）返回 null。解析失败抛错，调用方自行兜底。
 *
 * 帧数据按 chunk 顺序归属：第 0 帧 = 全部 IDAT；第 i 帧(i>0) = fcTL[i] 之后、
 * fcTL[i+1] 之前的 fdAT（fdAT 的 seq 字段按规范连续递增）。合成遵循 APNG 的
 * dispose_op / blend_op。
 */
export function decodeApng(buf: Buffer): RgbaFrame[] | null {
  const chunks = parsePngChunks(buf);
  if (!chunks) return null;
  if (!chunks.some((c) => c.type === 'acTL')) return null;

  const ihdr = chunks.find((c) => c.type === 'IHDR')?.data;
  if (!ihdr || ihdr.length < 13) throw new Error('apng: missing IHDR');
  const canvasW = ihdr.readUInt32BE(0);
  const canvasH = ihdr.readUInt32BE(4);
  const bitDepth = ihdr.readUInt8(8);
  const colorType = ihdr.readUInt8(9);

  const idat: Buffer[] = [];
  const fdatSeq = new Map<number, Buffer[]>();
  const fctl: FcTlInfo[] = [];

  for (const c of chunks) {
    if (c.type === 'IDAT') {
      idat.push(c.data);
    } else if (c.type === 'fcTL' && c.data.length >= 26) {
      const delayNum = c.data.readUInt16BE(20);
      const delayDen = c.data.readUInt16BE(22);
      fctl.push({
        seq: c.data.readUInt32BE(0),
        width: c.data.readUInt32BE(4),
        height: c.data.readUInt32BE(8),
        x: c.data.readUInt32BE(12),
        y: c.data.readUInt32BE(16),
        delayMs: (delayNum * 1000) / (delayDen || 100),
        disposeOp: c.data.readUInt8(24),
        blendOp: c.data.readUInt8(25),
      });
    } else if (c.type === 'fdAT' && c.data.length >= 4) {
      const seq = c.data.readUInt32BE(0);
      const list = fdatSeq.get(seq) ?? [];
      list.push(c.data.subarray(4));
      fdatSeq.set(seq, list);
    }
  }

  if (fctl.length === 0) return null;
  const orderedFdat = [...fdatSeq.entries()].sort((a, b) => a[0] - b[0]);

  const frames: RgbaFrame[] = [];
  const canvas = Buffer.alloc(canvasW * canvasH * 4);
  let lastRect: { x: number; y: number; w: number; h: number } | null = null;

  for (let i = 0; i < fctl.length; i++) {
    const info = fctl[i]!;

    // 上一帧 dispose=2：清掉上一帧矩形（恢复背景）。
    if (i > 0 && fctl[i - 1]!.disposeOp === 2 && lastRect) {
      clearRect(canvas, canvasW, lastRect);
    }

    if (i === 0) {
      const sub = PNG.sync.read(
        Buffer.concat(
          idat.length > 0 ? idat : [emptySubPng(info.width, info.height, bitDepth, colorType)],
        ),
      );
      for (let p = 0; p < canvas.length; p += 4) {
        canvas[p] = sub.data[p]!;
        canvas[p + 1] = sub.data[p + 1]!;
        canvas[p + 2] = sub.data[p + 2]!;
        canvas[p + 3] = sub.data[p + 3]!;
      }
    } else {
      // fdAT 属于帧 i：seq 在 (fcTL[i].seq, fcTL[i+1].seq) 区间内。
      const start = orderedFdat.findIndex(([seq]) => seq >= info.seq + 1);
      const end =
        i + 1 < fctl.length
          ? orderedFdat.findIndex(([seq]) => seq >= fctl[i + 1]!.seq)
          : orderedFdat.length;
      const parts =
        start >= 0 ? orderedFdat.slice(start, end < 0 ? undefined : end).flatMap(([, d]) => d) : [];
      const frameData = parts.length > 0 ? Buffer.concat(parts) : Buffer.alloc(0);
      const sub = PNG.sync.read(
        buildSubPng(info.width, info.height, bitDepth, colorType, frameData),
      );
      drawRect(canvas, canvasW, canvasH, info, sub);
    }

    lastRect = { x: info.x, y: info.y, w: info.width, h: info.height };
    frames.push({
      data: Buffer.from(canvas),
      width: canvasW,
      height: canvasH,
      delayMs: info.delayMs,
    });
  }

  return frames;
}

function clearRect(
  canvas: Buffer,
  w: number,
  rect: { x: number; y: number; w: number; h: number },
): void {
  for (let y = 0; y < rect.h; y++) {
    const cy = rect.y + y;
    for (let x = 0; x < rect.w; x++) {
      const cx = rect.x + x;
      const di = (cy * w + cx) * 4;
      canvas[di + 3] = 0;
    }
  }
}

function drawRect(
  canvas: Buffer,
  canvasW: number,
  canvasH: number,
  info: FcTlInfo,
  sub: PNG,
): void {
  for (let y = 0; y < info.height; y++) {
    const cy = info.y + y;
    if (cy >= canvasH) break;
    for (let x = 0; x < info.width; x++) {
      const cx = info.x + x;
      if (cx >= canvasW) continue;
      const si = (y * info.width + x) * 4;
      const di = (cy * canvasW + cx) * 4;
      if (info.blendOp === 0) {
        canvas[di] = sub.data[si]!;
        canvas[di + 1] = sub.data[si + 1]!;
        canvas[di + 2] = sub.data[si + 2]!;
        canvas[di + 3] = sub.data[si + 3]!;
      } else {
        const sa = sub.data[si + 3]!;
        if (sa === 0) continue;
        if (sa === 255) {
          canvas[di] = sub.data[si]!;
          canvas[di + 1] = sub.data[si + 1]!;
          canvas[di + 2] = sub.data[si + 2]!;
          canvas[di + 3] = 255;
        } else {
          const da = canvas[di + 3]!;
          const oa = sa + (da * (255 - sa)) / 255;
          if (oa === 0) continue;
          canvas[di] = Math.round(
            (sub.data[si]! * sa + (canvas[di]! * da * (255 - sa)) / 255) / oa,
          );
          canvas[di + 1] = Math.round(
            (sub.data[si + 1]! * sa + (canvas[di + 1]! * da * (255 - sa)) / 255) / oa,
          );
          canvas[di + 2] = Math.round(
            (sub.data[si + 2]! * sa + (canvas[di + 2]! * da * (255 - sa)) / 255) / oa,
          );
          canvas[di + 3] = Math.round(oa);
        }
      }
    }
  }
}

/** 用子图数据拼一个合法 PNG（IHDR + IDAT + IEND），交给 pngjs 解码。 */
function buildSubPng(
  w: number,
  h: number,
  bitDepth: number,
  colorType: number,
  data: Buffer,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(bitDepth, 8);
  ihdr.writeUInt8(colorType, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', data),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function emptySubPng(w: number, h: number, bitDepth: number, colorType: number): Buffer {
  return buildSubPng(w, h, bitDepth, colorType, Buffer.alloc(0));
}

/** 判断一个 PNG 文件是不是 APNG（含 acTL 块）。 */
export function isApng(buf: Buffer): boolean {
  const chunks = parsePngChunks(buf);
  return Boolean(chunks?.some((c) => c.type === 'acTL'));
}
