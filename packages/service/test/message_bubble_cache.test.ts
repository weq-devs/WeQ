import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { TrpcNative } from '@weq/protocol';
import type { NtHelperBinding } from '@weq/native';
import { DressSharedCache } from '../src/account/dress_shared_cache';
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
