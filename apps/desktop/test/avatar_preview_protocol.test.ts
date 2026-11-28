// @vitest-environment node
import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { handleAvatarRequest } from '../src/main/avatar_protocol';
import { setupImageWorker } from './support/image-worker';
import { MediaCacheService } from '@weq/service';
import { UNKNOWN_NETWORK } from '@weq/service/data-saver';
import { updateTransferPolicy } from '@weq/service/transfer-policy';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

setupImageWorker();

const get = vi.hoisted(() => vi.fn());
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ bootstrap: { avatarCache: { get } } }),
}));

it('预览协议返回真实缩图，默认原图保持原始字节，损坏预览不回退大图', async () => {
  const original = await sharp({
    create: { width: 1800, height: 2400, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  get.mockResolvedValue({ data: original, contentType: 'image/png' });
  const url = 'weq-avatar://fetch?src=https%3A%2F%2Fexample.invalid%2Ffixture';
  const preview = await handleAvatarRequest(new Request(`${url}&preview=1`));
  expect(preview.status).toBe(200);
  expect(preview.headers.get('Content-Type')).toBe('image/webp');
  expect(await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).toMatchObject({
    width: 384,
    height: 512,
  });
  const full = await handleAvatarRequest(new Request(url));
  expect(Buffer.from(await full.arrayBuffer())).toEqual(original);
  get.mockResolvedValue({ data: Buffer.from('bad'), contentType: 'image/png' });
  const failed = await handleAvatarRequest(new Request(`${url}&preview=1`));
  expect(failed.status).toBe(502);
  expect(failed.headers.get('Content-Type')).not.toBe('image/png');
});

it('省流量时卡片复用已有图片，新配图不能借头像开关联网，主动加载后可复用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-card-preview-policy-'));
  const cache = new MediaCacheService({ cacheDir: (subdir) => join(dir, subdir ?? '') });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  const fetch = vi.fn(
    async () => new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png' } }),
  );
  vi.stubGlobal('fetch', fetch);
  get.mockImplementation(cache.get.bind(cache));
  const cover =
    'weq-avatar://fetch?resource=link-preview&src=https%3A%2F%2Ffixture.invalid%2Fcard.png';
  const read = (url: string) => handleAvatarRequest(new Request(url));
  try {
    await mkdir(join(dir, 'avatar'));
    updateTransferPolicy('always', UNKNOWN_NETWORK);
    expect((await read(cover)).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect((await read(cover + '&intent=interactive')).ok).toBe(true);
    expect((await read(cover)).ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    get.mockReset();
    updateTransferPolicy('auto', UNKNOWN_NETWORK);
    vi.unstubAllGlobals();
    await rm(dir, { force: true, recursive: true });
  }
});
