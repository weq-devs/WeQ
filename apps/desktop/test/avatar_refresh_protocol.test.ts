import { beforeEach, expect, it, vi } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol';
import { handleAvatarRequest } from '../src/main/avatar_protocol';

const mock = vi.hoisted(() => ({ get: vi.fn(), local: vi.fn() }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    bootstrap: { avatarCache: { get: mock.get } },
    services: { avatarResource: { resolveByUid: mock.local } },
  }),
}));
const upstream = 'https://p.qlogo.cn/gh/123/123/0';
const bridge = `weq-media://avatar?scope=group&uid=123&fb=${encodeURIComponent(upstream)}`;
beforeEach(() => {
  mock.get.mockReset().mockResolvedValue({ data: Buffer.from('fresh'), contentType: 'image/png' });
  mock.local.mockReset().mockResolvedValue(null);
});

it('显式修改后优先回源，沿用原始缓存键，普通请求保留本地优先', async () => {
  const response = await handleMediaRequest(new Request(`${bridge}&_weq_avatar_remote=1`));
  expect(await response.text()).toBe('fresh');
  expect(mock.get).toHaveBeenCalledWith(upstream, 'avatar', 0);
  expect(mock.local).not.toHaveBeenCalled();
  mock.get.mockClear();
  await handleMediaRequest(new Request(bridge));
  expect(mock.local).toHaveBeenCalled();
  expect(mock.get).toHaveBeenCalledWith(upstream, 'avatar', undefined);
});
it('回源失败仍可退回已有缓存，不把头像清空', async () => {
  mock.get.mockRejectedValueOnce(new Error('offline'));
  const response = await handleMediaRequest(new Request(`${bridge}&_weq_avatar_remote=1`));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('fresh');
  expect(mock.local).toHaveBeenCalled();
});
it('远程头像桥同样支持显式回源，版本不进入上游 URL', async () => {
  const response = await handleAvatarRequest(
    new Request(`weq-avatar://fetch?src=${encodeURIComponent(upstream)}&_weq_avatar_remote=1`),
  );
  expect(response.status).toBe(200);
  expect(mock.get).toHaveBeenCalledWith(upstream, 'avatar', 0);
});
