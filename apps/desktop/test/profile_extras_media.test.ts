// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol';
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ services: {} }),
  requirePlatform: () => ({}),
}));
afterEach(() => vi.unstubAllGlobals());
it('标签照片沿用相册代理，保留图片内容并附加同协议 Referer', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const fetch = vi.fn(
    async () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } }),
  );
  vi.stubGlobal('fetch', fetch);
  const src = 'http://ugc.qpic.cn/profile/photo';
  const response = await handleMediaRequest(
    new Request(`weq-media://album?src=${encodeURIComponent(src)}`),
  );
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(fetch).toHaveBeenCalledWith(
    src,
    expect.objectContaining({
      headers: expect.objectContaining({ Referer: 'http://user.qzone.qq.com/' }),
    }),
  );
});
