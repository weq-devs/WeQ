import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { handleAvatarRequest } from '../src/main/avatar_protocol';

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
