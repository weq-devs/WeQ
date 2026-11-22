// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import sharp from 'sharp';
import { chatImageResponse } from '../src/main/chat_image_response';
import { imageThumbnail } from '../src/main/image_processor';
import { PREVIEW_MAX_SIDE } from '../src/main/image_preview';
import { setupImageWorker } from './support/image-worker';

setupImageWorker();

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function makeBmp(width: number, height: number, pixelBytes: 3 | 4, topDown: boolean) {
  const rowBytes = Math.ceil((width * pixelBytes) / 4) * 4;
  const bmp = Buffer.alloc(54 + rowBytes * height);
  bmp.write('BM');
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(topDown ? -height : height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(pixelBytes * 8, 28);
  bmp.writeUInt32LE(rowBytes * height, 34);
  for (let row = 0; row < height; row++) {
    const red = topDown ? row < height / 2 : row >= height / 2;
    const channel = red ? 2 : 0;
    for (let col = 0; col < width; col++)
      bmp[54 + row * rowBytes + col * pixelBytes + channel] = 255;
  }
  return bmp;
}

it.each([
  { bitDepth: 24, pixelBytes: 3, topDown: false },
  { bitDepth: 32, pixelBytes: 4, topDown: true },
] as const)(
  '为 $bitDepth 位 BMP 生成方向和颜色正确的气泡缩略图',
  async ({ pixelBytes, topDown }) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-chat-bmp-'));
    roots.push(root);
    const path = join(root, 'chatpic.bmp');
    const width = 289;
    const height = 600;
    await writeFile(path, makeBmp(width, height, pixelBytes, topDown));

    const response = await chatImageResponse(path);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    const { data, info } = await sharp(Buffer.from(await response.arrayBuffer()))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.height).toBe(PREVIEW_MAX_SIDE);
    expect(info.width).toBe(Math.round((width * PREVIEW_MAX_SIDE) / height));
    expect(info.channels).toBe(3);
    const top = (Math.floor(info.height / 4) * info.width + 2) * info.channels;
    const bottom = (Math.floor((info.height * 3) / 4) * info.width + 2) * info.channels;
    expect(data[top]).toBeGreaterThan(240);
    expect(data[top + 2]).toBeLessThan(15);
    expect(data[bottom]).toBeLessThan(15);
    expect(data[bottom + 2]).toBeGreaterThan(240);
  },
);

it('BMP 同样限制像素数，像素数据截断时保留占位图', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-chat-bmp-invalid-'));
  roots.push(root);
  const path = join(root, 'truncated.bmp');
  const bmp = makeBmp(9, 8, 3, false);
  await expect(imageThumbnail(bmp, 71, true)).rejects.toThrow('BMP pixel limit');

  await writeFile(path, bmp.subarray(0, -1));
  const response = await chatImageResponse(path);
  expect(response.headers.get('Content-Type')).toContain('image/svg+xml');
});

it('本地大图的气泡响应是真实小图，原文件不改写，来源失效拒绝响应', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-chat-preview-'));
  roots.push(root);
  const path = join(root, 'image.png');
  const input = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  await writeFile(path, input);
  const response = await chatImageResponse(path);
  expect(response.headers.get('Content-Type')).toBe('image/webp');
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  expect(metadata.width).toBe(PREVIEW_MAX_SIDE);
  expect(metadata.height).toBe(PREVIEW_MAX_SIDE / 2);
  expect((await sharp(path).metadata()).width).toBe(2000);
  await expect(
    chatImageResponse(path, undefined, () => {
      throw new Error('来源已切换');
    }),
  ).rejects.toThrow('来源已切换');
});

it('像素超限或坏图不会直接回退成原图，聊天仍有可点击占位', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-chat-oversize-'));
  roots.push(root);
  const path = join(root, 'oversized.png');
  const oversized = await sharp({
    create: { width: 6000, height: 6000, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  await writeFile(path, oversized);
  const response = await chatImageResponse(path);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toContain('image/svg+xml');
  expect(await response.text()).toContain('点击查看原图');

  const broken = join(root, 'broken.png');
  await writeFile(broken, Buffer.from('not an image'));
  const invalid = await chatImageResponse(broken);
  expect(invalid.headers.get('Content-Type')).toContain('image/svg+xml');
});

it('多帧 GIF 仍返回动画，不能被小图优化变成静态首帧', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-chat-animation-'));
  roots.push(root);
  const path = join(root, 'animation.gif');
  const pixels = Buffer.alloc(4 * 8 * 3);
  for (let index = 0; index < 32; index++) pixels[index * 3 + (index < 16 ? 0 : 2)] = 255;
  const input = await sharp(pixels, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } })
    .gif({ delay: [100, 100] })
    .toBuffer();
  expect((await sharp(input).metadata()).pages).toBe(2);
  await writeFile(path, input);
  const response = await chatImageResponse(path);
  const output = Buffer.from(await response.arrayBuffer());
  expect(output).toEqual(input);
  expect((await sharp(output).metadata()).pages).toBe(2);
});
