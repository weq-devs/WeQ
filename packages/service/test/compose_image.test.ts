/**
 * `ComposeImageService` —— 「新增消息」选一张本机图片时的落盘与元素构造。
 *
 * 这里钉住的是**寻址契约**：聊天里的图片靠 `weq-media://pic?t=<发送时间>&name=<文件名>`
 * 去 `nt_data/Pic/<YYYY-MM>/{Ori,Thumb}/` 里按文件名主干找图（FileSearchService），所以
 *  - 落盘目录必须是**发送时间所在月份**的 `Ori`；
 *  - 文件名主干必须是 md5（QQ 自己的命名规则）；
 *  - 元素里除本地能确定的那几项之外，不编任何 CDN / 下载字段。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { ComposeImageService } from '../src/account/compose_image';

let dir: string;
let picRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-compose-image-'));
  picRoot = join(dir, 'nt_data', 'Pic');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 只够 `detectImageFormat` 读宽高的最小 PNG：签名 + IHDR 长度/类型 + 宽高。 */
function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** 月中正午 UTC —— 任何时区下本地月份都还是 09。 */
const SEND_TIME = Math.floor(Date.UTC(2026, 8, 15, 12, 0, 0) / 1000);

function service(picDir: string | null = picRoot): ComposeImageService {
  const session = { context: { uin: '10001' } } as unknown as AccountSession;
  const platform = { picDir: () => picDir } as unknown as Platform;
  return new ComposeImageService(session, platform);
}

describe('ComposeImageService.stage', () => {
  it('copies the image into the send-time month and builds a minimal pic element', async () => {
    const bytes = pngBytes(640, 360);
    const src = join(dir, 'photo.png');
    writeFileSync(src, bytes);
    const md5 = createHash('md5').update(bytes).digest('hex');

    const staged = await service().stage(src, SEND_TIME);

    expect(staged.sendTime).toBe(SEND_TIME);
    expect(existsSync(join(picRoot, '2026-09', 'Ori', `${md5}.png`))).toBe(true);

    expect(staged.element).toMatchObject({
      kind: 'pic',
      fileName: `${md5}.png`,
      md5: md5.toUpperCase(),
      fileSize: bytes.length,
      imgType: 1001,
      isOriginal: true,
      imgWidth: 640,
      imgHeight: 360,
      subType: 0,
      localPath: join(picRoot, '2026-09', 'Ori', `${md5}.png`),
    });
    const md5Bytes = staged.element.md5Bytes as Uint8Array;
    expect(md5Bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(md5Bytes).toString('hex')).toBe(md5);
    // 从没上传过的图不编 CDN / 下载字段。
    expect(staged.element.fileToken).toBeUndefined();
    expect(staged.element.originalUrl).toBeUndefined();

    expect(staged.preview).toEqual({
      type: 'pic',
      data: {
        fileName: `${md5}.png`,
        fileSize: bytes.length,
        imgWidth: 640,
        imgHeight: 360,
        imgType: 1001,
        isOriginal: true,
        subType: 0,
      },
    });
  });

  it('is idempotent: re-staging the same bytes leaves the file untouched', async () => {
    const bytes = pngBytes(64, 48);
    const src = join(dir, 'photo.png');
    writeFileSync(src, bytes);
    const md5 = createHash('md5').update(bytes).digest('hex');
    const target = join(picRoot, '2026-09', 'Ori', `${md5}.png`);

    await service().stage(src, SEND_TIME);
    const before = statSync(target).mtimeMs;
    const again = await service().stage(src, SEND_TIME);
    expect(again.element.localPath).toBe(target);
    expect(statSync(target).mtimeMs).toBe(before);
  });

  it('falls back to the real format when the file has no usable extension', async () => {
    const bytes = pngBytes(32, 16);
    const src = join(dir, 'mystery.bin');
    writeFileSync(src, bytes);

    const staged = await service().stage(src, SEND_TIME);
    expect(String(staged.element.fileName)).toMatch(/\.png$/);
    expect(staged.element.imgWidth).toBe(32);
  });

  it('throws when the account has no Pic cache directory', async () => {
    const src = join(dir, 'photo.png');
    writeFileSync(src, pngBytes(8, 8));
    await expect(service(null).stage(src, SEND_TIME)).rejects.toThrow(/nt_data\/Pic/);
  });
});
