import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { TrpcNative } from '@weq/protocol';
import type { NtHelperBinding } from '@weq/native';
import { DressSharedCache } from '../src/account/dress_shared_cache';

it('账号准备时读取本地气泡，消息热路径只读内存且不依赖在线 QQ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-message-bubbles-'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0AAAAABJRU5ErkJggg==',
    'base64',
  );
  try {
    mkdirSync(join(dir, 'bubbles'));
    writeFileSync(join(dir, 'bubbles/21991.png'), png);
    writeFileSync(
      join(dir, 'bubbles/21991.json'),
      JSON.stringify({
        slice: { left: 0, right: 0, top: 0, bottom: 0 },
        imageSize: { w: 1, h: 1 },
        textColor: '#516196',
      }),
    );
    writeFileSync(join(dir, 'bubbles/21992.json'), '{broken');
    const cache = new DressSharedCache({} as TrpcNative, {} as NtHelperBinding, dir, () => 0);
    await cache.prepareMessageRendering();
    const skin = cache.messageBubble(21991);
    expect(skin?.baseImage).toBe(`data:image/png;base64,${png.toString('base64')}`);
    rmSync(join(dir, 'bubbles'), { recursive: true });
    expect(cache.messageBubble(21991)).toBe(skin);
    expect(cache.messageBubble(21992)).toBeUndefined();
    expect(cache.messageBubble(99999)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
