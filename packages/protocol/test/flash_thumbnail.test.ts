/**
 * 闪传封面缩略图格式探测（`prepareThumbnail` 的「直通」闸门）。
 *
 * 用户自定义封面走直通（渲染层不再重绘 / 压缩），落盘的可能是 PNG 也可能是 JPEG。
 * 两种格式对应不同的缩略图 appid（PNG 14903 / JPEG 14902）与 formatCode（26 / 2），
 * 所以 prepare 前必须按字节 magic 认出格式；认不出（WebP / GIF / BMP / 尺寸非法）就
 * 直接拒绝，不能拿错误的 appid 硬传 —— 那会让卡片回退默认封面。
 */

import { describe, expect, it } from 'vitest';
import { detectThumbType } from '../src/index';

/** 最小合法 PNG：签名 + IHDR（1×1）。 */
function png(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(bytes.buffer).setUint32(8, 13); // IHDR chunk length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** 最小 JPEG：SOI + SOF0 段（1×1）。 */
function jpeg(width = 1, height = 1): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08, // SOF0, length 17, precision 8
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01, // component specs
    0xff,
    0xd9, // EOI
  ]);
}

describe('detectThumbType', () => {
  it('PNG 签名 → png', () => {
    expect(detectThumbType(png(480, 270))).toBe('png');
  });

  it('JPEG（SOI + SOF0）→ jpg', () => {
    expect(detectThumbType(jpeg(480, 270))).toBe('jpg');
  });

  it('尺寸非法（0×0）→ 拒绝', () => {
    expect(detectThumbType(png(0, 0))).toBeNull();
  });

  it('其它格式（WebP / GIF / BMP / 纯文本）→ 拒绝', () => {
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
    webp.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
    expect(detectThumbType(webp)).toBeNull();

    const gif = new Uint8Array(10);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // 'GIF89a'
    expect(detectThumbType(gif)).toBeNull();

    expect(detectThumbType(new TextEncoder().encode('not an image'))).toBeNull();
    expect(detectThumbType(new Uint8Array(0))).toBeNull();
  });
});
