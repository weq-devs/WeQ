import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { expect, it, vi } from 'vitest';
import type { TrpcNative } from '@weqbot/protocol';
import type { NtHelperBinding } from '@weq/native';
import { DressSharedCache } from '../src/account/dress_shared_cache';
import { BUBBLE_GEOMETRY_VERSION } from '../src/account/bubble_skin';
import { buildZip } from '../src/common/zip';
import { ninePatch } from './support/nine_patch';

it('账号准备时读取本地气泡，消息热路径只读内存且不依赖在线 QQ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-message-bubbles-'));
  const png = ninePatch(128, 112, [76, 77], [49, 50]);
  try {
    mkdirSync(join(dir, 'bubbles'));
    writeFileSync(join(dir, 'bubbles/21991.png'), png);
    writeFileSync(
      join(dir, 'bubbles/21991.json'),
      JSON.stringify({
        slice: { left: 73, right: 47, top: 46, bottom: 58 },
        imageSize: { w: 128, h: 112 },
        textColor: '#516196',
      }),
    );
    writeFileSync(join(dir, 'bubbles/21992.json'), '{broken');
    const cache = new DressSharedCache({} as TrpcNative, {} as NtHelperBinding, dir, () => 0);
    await cache.prepareMessageRendering();
    const skin = cache.messageBubble(21991);
    expect(skin?.baseImage).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(skin?.slice).toEqual({ left: 76, right: 51, top: 49, bottom: 62 });
    rmSync(join(dir, 'bubbles'), { recursive: true });
    expect(cache.messageBubble(21991)).toBe(skin);
    expect(cache.messageBubble(21992)).toBeUndefined();
    expect(cache.messageBubble(99999)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('旧气泡缓存补记透明外沿，保留单个装饰像素和未知动画外沿', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-message-bubbles-'));
  try {
    mkdirSync(join(dir, 'bubbles'));
    const image = new PNG({ width: 16, height: 24 });
    for (let y = 8; y < 16; y++) image.data.fill(255, y * 64, (y + 1) * 64);
    // 离主体 6px 的角落装饰也计入外沿，即使只有一个半透明像素。
    image.data[(2 * 16 + 1) * 4 + 3] = 32;
    const imageData = PNG.sync.write(image);
    const sidecar = {
      slice: { left: 7, right: 8, top: 10, bottom: 13 },
      imageSize: { w: 16, h: 24 },
      geometryVersion: BUBBLE_GEOMETRY_VERSION,
      textColor: '#516196',
    };
    for (const [id, animationFrameCount] of [
      [1001, undefined],
      [1002, 2],
    ] as const) {
      writeFileSync(join(dir, `bubbles/${id}.png`), imageData);
      writeFileSync(
        join(dir, `bubbles/${id}.json`),
        JSON.stringify({ ...sidecar, animationFrameCount }),
      );
    }
    const cache = new DressSharedCache({} as TrpcNative, {} as NtHelperBinding, dir, () => 0);
    await cache.prepareMessageRendering();
    expect(cache.messageBubble(1001)?.transparentInsets).toEqual({ top: 2, bottom: 8 });
    expect(cache.messageBubble(1002)?.transparentInsets).toBeNull();
    expect(cache.getBubbleSkin(1001)?.transparentInsets).toEqual({ top: 2, bottom: 8 });
    expect(JSON.parse(readFileSync(join(dir, 'bubbles/1001.json'), 'utf8'))).toMatchObject({
      ...sidecar,
      transparentInsets: { top: 2, bottom: 8 },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('独立配置不可用时只下载一次动画包，按文件编号和解码器时长播放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-install-bubbles-'));
  const png = ninePatch(128, 112, [64, 72], [52, 60]);
  const second = ninePatch(128, 112, [66, 72], [52, 60]);
  const staticZip = buildZip([{ name: 'aio_user_bg_nor.9.png', data: png }]);
  const otherZip = buildZip([
    {
      name: 'config.json',
      data: Buffer.from(
        JSON.stringify({
          zoom_point: ['68', '56'],
          bubbleframe_animation: { animation_set: 'main' },
          animation_sets: {
            main: { zip_name: 'bubbleframe8', count: '0', time: '900', repeat: '3' },
          },
        }),
      ),
    },
    { name: 'bubbleframe8/0010.9.png', data: second },
    { name: 'bubbleframe8/002.png', data: png },
    { name: 'bubbleframe8/preview/001.9.png', data: second },
  ]);
  const fetch = vi.fn(
    async (url: string) =>
      new Response(new Uint8Array(url.endsWith('static.zip') ? staticZip : otherZip)),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    const native = {
      queryDressResourceUrl: (_kind: string, _id: string, part: string) =>
        part === 'static.zip' || part === 'other.zip'
          ? { url: `https://cdn.invalid/${part}` }
          : null,
    } as NtHelperBinding;
    const cache = new DressSharedCache({} as TrpcNative, native, dir, () => 0);
    expect(await cache.installBubble(2001)).toMatchObject({
      slice: { left: 68, right: 59, top: 56, bottom: 55 },
      animationFrameCount: 2,
      animationFrameTimeMs: 100,
      animationRepeat: 3,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(dir, 'bubbles/2001-frame-1.png'))).toEqual(png);
    expect(readFileSync(join(dir, 'bubbles/2001-frame-2.png'))).toEqual(second);
  } finally {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('旧动画包的独立配置优先，不在时用 ZIP 内配置纠正已缓存气泡', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-message-bubbles-'));
  const png = ninePatch(128, 112, [64, 72], [52, 60]);
  try {
    mkdirSync(join(dir, 'bubbles'));
    for (const id of [2001, 2002]) {
      const base = join(dir, 'bubbles', String(id));
      writeFileSync(`${base}.png`, png);
      writeFileSync(
        `${base}.json`,
        JSON.stringify({
          slice: { left: 64, right: 56, top: 52, bottom: 52 },
          imageSize: { w: 128, h: 112 },
          textColor: '#516196',
          geometryVersion: 1,
          animationFrameCount: 16,
          animationFrameTimeMs: 900,
          animationRepeat: 3,
        }),
      );
      writeFileSync(
        `${base}-other.zip`,
        buildZip([
          {
            name: 'config.json',
            data: Buffer.from(
              JSON.stringify({ zoom_point: ['68', '56'], link_color: '0xFF112233' }),
            ),
          },
        ]),
      );
    }
    writeFileSync(
      join(dir, 'bubbles/2002-config.json'),
      JSON.stringify({
        zoom_point: ['65', '54'],
        link_color: '0xFF445566',
      }),
    );
    const cache = new DressSharedCache({} as TrpcNative, {} as NtHelperBinding, dir, () => 0);
    await cache.prepareMessageRendering();
    expect(cache.messageBubble(2001)).toMatchObject({
      configuredPatch: true,
      slice: { left: 68, right: 59, top: 56, bottom: 55 },
      linkColor: 'rgb(17 34 51)',
      animationFrameCount: 16,
      animationFrameTimeMs: 100,
      animationRepeat: 3,
    });
    expect(cache.messageBubble(2002)).toMatchObject({
      slice: { left: 65, right: 62, top: 54, bottom: 57 },
      linkColor: 'rgb(68 85 102)',
    });
    expect(JSON.parse(readFileSync(join(dir, 'bubbles/2001.json'), 'utf8'))).toMatchObject({
      geometryVersion: BUBBLE_GEOMETRY_VERSION,
      zoomPoint: [68, 56],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
