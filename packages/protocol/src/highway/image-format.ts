/**
 * 图片格式探测 + 兜底封面合成。
 *
 * `detectImageFormat` 移植自 SnowLuma `highway/utils.ts`（对 C++
 * `detect_image_format` 的复刻），返回 NTV2 的 `picFormat` 码与像素尺寸：
 *   1000 jpg / 1001 png / 1002 webp / 1005 bmp / 2000 gif。
 * 发图时 picFormat 与 width/height 都要上 wire，QQ 端拿它们排版；探不出来就退回 jpg。
 *
 * `makeSolidPng` 生成一张纯色 PNG（真实像素 = 声明尺寸），给视频封面兜底 ——
 * SnowLuma 内嵌了一张 720×1280 的 base64 PNG（约 30 KB），我们用 zlib 现算一张，
 * 既不用背那个体积，也不会出现「声明 720×1280 实际 1×1」这种谎报尺寸
 * （QQ-NT 接收端会因此渲染「文件已过期」）。
 */

import { deflateSync } from 'node:zlib';

/** NTV2 picFormat：探测失败时的默认值（jpg）。 */
export const PIC_FORMAT_JPEG = 1000;
export const PIC_FORMAT_PNG = 1001;
export const PIC_FORMAT_WEBP = 1002;
export const PIC_FORMAT_BMP = 1005;
export const PIC_FORMAT_GIF = 2000;

export interface ImageFormat {
  /** NTV2 picFormat 码（1000/1001/1002/1005/2000）。 */
  format: number;
  width: number;
  height: number;
}

const readBE16 = (d: Uint8Array, o: number): number => (d[o]! << 8) | d[o + 1]!;
const readBE32 = (d: Uint8Array, o: number): number =>
  ((d[o]! << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!) >>> 0;
const readLE16 = (d: Uint8Array, o: number): number => d[o]! | (d[o + 1]! << 8);
const readLE32 = (d: Uint8Array, o: number): number =>
  (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;

/** 探测图片格式与像素尺寸；认不出来时返回 0×0 + jpg。 */
export function detectImageFormat(bytes: Uint8Array): ImageFormat {
  // PNG
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { format: PIC_FORMAT_PNG, width: readBE32(bytes, 16), height: readBE32(bytes, 20) };
  }

  // GIF87a / GIF89a
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { format: PIC_FORMAT_GIF, width: readLE16(bytes, 6), height: readLE16(bytes, 8) };
  }

  // BMP
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { format: PIC_FORMAT_BMP, width: readLE32(bytes, 18), height: readLE32(bytes, 22) };
  }

  // WebP（VP8 / VP8L / VP8X 三种 chunk）
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      return {
        format: PIC_FORMAT_WEBP,
        width: readLE16(bytes, 26) & 0x3fff,
        height: readLE16(bytes, 28) & 0x3fff,
      };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c) {
      const bits = readLE32(bytes, 21);
      return {
        format: PIC_FORMAT_WEBP,
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      // VP8X 的 canvas 宽高是 24-bit 小端且存的是「尺寸 - 1」。
      const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
      const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
      return { format: PIC_FORMAT_WEBP, width, height };
    }
  }

  // JPEG：扫 SOF0..SOF15（跳过 SOF4/8/12 的 DHT/JPG/DAC 段）
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xda) break; // SOS：后面是熵编码数据
      const segLen = readBE16(bytes, offset + 2);
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          format: PIC_FORMAT_JPEG,
          width: readBE16(bytes, offset + 7),
          height: readBE16(bytes, offset + 5),
        };
      }
      offset += 2 + segLen;
    }
    return { format: PIC_FORMAT_JPEG, width: 0, height: 0 };
  }

  return { format: PIC_FORMAT_JPEG, width: 0, height: 0 };
}

// ───────────────────────── 兜底封面（纯色 PNG） ─────────────────────────

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  const crcInput = new Uint8Array(4 + body.length);
  crcInput.set(out.subarray(4, 8), 0);
  crcInput.set(body, 4);
  view.setUint32(8 + body.length, crc32(crcInput), false);
  return out;
}

/**
 * 生成一张 `width × height` 的纯色 PNG（`[r,g,b]`），用于视频封面兜底。
 * 真实像素与声明尺寸一致，避免接收端因尺寸不符显示「文件已过期」。
 */
export function makeSolidPng(
  width: number,
  height: number,
  rgb: [number, number, number] = [32, 32, 32],
): Uint8Array {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, w, false);
  ihdrView.setUint32(4, h, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  // 每行 = 1 字节 filter(0) + w × RGB
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const at = rowStart + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)));
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
