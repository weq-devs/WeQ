// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol';

const mock = vi.hoisted(() => ({ get: vi.fn(), getLocal: vi.fn(), cachedAt: vi.fn() }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    bootstrap: {
      avatarCache: mock,
      userConfig: { getSettings: () => ({ qqShowCacheMinutes: 5 }) },
    },
  }),
}));
const src = 'https://images.qqshow.gtimg.com/images/10001/102.png';
const bridge = `weq-media://qqshow?src=${encodeURIComponent(src)}&revision=123`;
const old = { data: Buffer.from('old'), contentType: 'image/png' };

beforeEach(() => {
  mock.get.mockReset().mockResolvedValue({ data: Buffer.from('fresh'), contentType: 'image/png' });
  mock.getLocal.mockReset().mockResolvedValue(old);
  mock.cachedAt.mockReset().mockResolvedValue(Date.now() - 300_001);
});

it('固定图片 URL 超过设置有效期后强制刷新，版本号不传到 CDN', async () => {
  const result = await handleMediaRequest(new Request(bridge));
  expect(await result.text()).toBe('fresh');
  expect(mock.get).toHaveBeenCalledWith(src, 'qqshow', 0);
  expect(result.headers.get('Cache-Control')).toBe('no-cache');
});

it('有效期内只读本地图片，不发网络请求', async () => {
  mock.cachedAt.mockResolvedValue(Date.now() - 60_000);
  const result = await handleMediaRequest(new Request(bridge));
  expect(await result.text()).toBe('old');
  expect(mock.get).not.toHaveBeenCalled();
});

it('刷新失败可持续使用旧图，无旧图才返回未找到', async () => {
  mock.get.mockRejectedValue(new Error('offline'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await handleMediaRequest(new Request(bridge));
    expect(await result.text()).toBe('old');
  }
  mock.getLocal.mockResolvedValue(null);
  expect((await handleMediaRequest(new Request(bridge))).status).toBe(404);
});

it('不接受非 QQ 秀域名', async () => {
  const result = await handleMediaRequest(
    new Request(`weq-media://qqshow?src=${encodeURIComponent('https://example.com/image.png')}`),
  );
  expect(result.status).toBe(404);
  expect(mock.get).not.toHaveBeenCalled();
});
