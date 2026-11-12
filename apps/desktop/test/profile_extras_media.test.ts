// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol';
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ services: {} }),
  requirePlatform: () => ({}),
}));
afterEach(() => vi.unstubAllGlobals());
it('实况视频保留分段流并移除 Electron 不接受的逐跳头', async () => {
  const bytes = new Uint8Array([0, 0, 0, 32]);
  const fetch = vi.fn(
    async () =>
      new Response(bytes, {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': '4',
          'Content-Range': 'bytes 0-3/100',
          Connection: 'keep-alive, x-upstream',
          'Keep-Alive': 'timeout=5',
          'X-Upstream': 'private-hop',
        },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const src = 'https://photovideo.photo.qq.com/fixture.mp4';
  const response = await handleMediaRequest(
    new Request(`weq-media://album?src=${encodeURIComponent(src)}`, {
      headers: { Range: 'bytes=0-3' },
    }),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe('bytes 0-3/100');
  expect(response.headers.get('content-length')).toBe('4');
  for (const header of ['connection', 'keep-alive', 'x-upstream'])
    expect(response.headers.has(header)).toBe(false);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(fetch).toHaveBeenCalledWith(
    src,
    expect.objectContaining({
      headers: expect.objectContaining({ Range: 'bytes=0-3' }),
    }),
  );
});
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
