import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createImagePreviewer, PREVIEW_MAX_SIDE } from '../src/main/image_preview';

describe('受限图片预览', () => {
  it('大原图变成真实小图，不修改输入；透明、旋转和损坏输入有明确结果', async () => {
    const input = await sharp({
      create: { width: 3456, height: 4608, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const preview = createImagePreviewer();
    const output = await preview(() => Promise.resolve(input));
    const info = await sharp(output).metadata();
    expect(info.width).toBeLessThanOrEqual(PREVIEW_MAX_SIDE);
    expect(info.height).toBeLessThanOrEqual(PREVIEW_MAX_SIDE);
    expect(info.format).toBe('webp');
    expect((await sharp(input).metadata()).width).toBe(3456);
    const transparent = await sharp({
      create: { width: 40, height: 80, channels: 4, background: '#00000000' },
    })
      .png()
      .toBuffer();
    expect((await sharp(await preview(async () => transparent)).metadata()).hasAlpha).toBe(true);
    const rotated = await sharp({
      create: { width: 80, height: 40, channels: 3, background: '#123456' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(await sharp(await preview(async () => rotated)).metadata()).toMatchObject({
      width: 40,
      height: 80,
    });
    await expect(preview(async () => Buffer.from('not an image'))).rejects.toThrow();
  });

  it('超过输入像素预算时拒绝，而不是回退返回原图', async () => {
    const input = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const preview = createImagePreviewer({ maxPixels: 100 });
    await expect(preview(async () => input)).rejects.toThrow();
  });

  it('排队时不提前读取大文件，队列满明确失败，失败后容量可复用', async () => {
    const preview = createImagePreviewer({ maxPending: 1 });
    let release: (data: Buffer) => void = () => {};
    const first = preview(
      () =>
        new Promise<Buffer>((resolve) => {
          release = resolve;
        }),
    );
    let secondLoaded = false;
    const second = preview(async () => {
      secondLoaded = true;
      return Buffer.from('bad');
    });
    expect(secondLoaded).toBe(false);
    await expect(preview(async () => Buffer.from('bad'))).rejects.toThrow('preview capacity');
    release(Buffer.from('bad'));
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(secondLoaded).toBe(true);
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    await expect(preview(async () => image)).resolves.toBeInstanceOf(Buffer);
  });
});
