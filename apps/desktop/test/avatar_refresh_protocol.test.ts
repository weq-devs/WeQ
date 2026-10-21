import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol';
import { handleAvatarRequest } from '../src/main/avatar_protocol';

const mock = vi.hoisted(() => ({
  get: vi.fn(),
  cachedAt: vi.fn(),
  localFile: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    bootstrap: { avatarCache: { get: mock.get, cachedAt: mock.cachedAt } },
    services: { avatarResource: { resolveByUidFile: mock.localFile } },
  }),
}));
const upstream = 'https://p.qlogo.cn/gh/123/123/0';
const bridge = `weq-media://avatar?scope=group&uid=123&fb=${encodeURIComponent(upstream)}`;

let dir = '';
let bigPath = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weq-avatar-protocol-'));
  bigPath = join(dir, 'b_local');
  await writeFile(bigPath, 'local-big');
  mock.get.mockReset().mockResolvedValue({ data: Buffer.from('fresh'), contentType: 'image/png' });
  mock.cachedAt.mockReset().mockResolvedValue(null);
  mock.localFile
    .mockReset()
    .mockResolvedValue({ path: bigPath, variant: 'big', stale: false, mtimeMs: Date.now() });
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('显式修改后优先回源，沿用原始缓存键，普通请求保留本地优先', async () => {
  const response = await handleMediaRequest(new Request(`${bridge}&_weq_avatar_remote=1`));
  expect(await response.text()).toBe('fresh');
  expect(mock.get).toHaveBeenCalledWith(upstream, 'avatar', 0);
  mock.get.mockClear();
  const local = await handleMediaRequest(new Request(bridge));
  expect(await local.text()).toBe('local-big');
  expect(mock.localFile).toHaveBeenCalled();
  expect(mock.get).not.toHaveBeenCalled();
});
it('显式回源失败仍可退回已有缓存，不把头像清空', async () => {
  // 本地只有过期的旧大图，显式刷新（ttl=0）失败后走缓存里的上一版 CDN 头像。
  mock.localFile.mockResolvedValue({
    path: bigPath,
    variant: 'big',
    stale: true,
    mtimeMs: 1_000,
  });
  mock.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
    data: Buffer.from('cached'),
    contentType: 'image/png',
  });
  const response = await handleMediaRequest(new Request(`${bridge}&_weq_avatar_remote=1`));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('cached');
  expect(mock.get).toHaveBeenLastCalledWith(upstream, 'avatar', undefined);
});
it('回源失败且本地文件就是最新的 → 直接用本地文件', async () => {
  mock.get.mockRejectedValue(new Error('offline'));
  const response = await handleMediaRequest(new Request(`${bridge}&_weq_avatar_remote=1`));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('local-big');
});
it('远程头像桥同样支持显式回源，版本不进入上游 URL', async () => {
  const response = await handleAvatarRequest(
    new Request(`weq-avatar://fetch?src=${encodeURIComponent(upstream)}&_weq_avatar_remote=1`),
  );
  expect(response.status).toBe(200);
  expect(mock.get).toHaveBeenCalledWith(upstream, 'avatar', 0);
});

it('本地只有缩略图是新的（大图过期）→ 回源 CDN，而不是显示旧大图', async () => {
  const smallPath = join(dir, 's_local');
  await writeFile(smallPath, 'local-small');
  mock.localFile.mockResolvedValue({
    path: smallPath,
    variant: 'small',
    stale: true,
    mtimeMs: 1_000,
  });
  mock.cachedAt.mockResolvedValue(500); // 缓存比本地缩略图还旧 → 强制重拉
  const response = await handleMediaRequest(new Request(bridge));
  expect(await response.text()).toBe('fresh');
  expect(mock.get).toHaveBeenCalledWith(upstream, 'avatar', 0);
});

it('CDN 拿不到时退回缩略图，不退回旧大图', async () => {
  const smallPath = join(dir, 's_local');
  await writeFile(smallPath, 'local-small');
  mock.localFile.mockResolvedValue({
    path: smallPath,
    variant: 'small',
    stale: true,
    mtimeMs: 1_000,
  });
  mock.get.mockRejectedValue(new Error('offline'));
  const response = await handleMediaRequest(new Request(bridge));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('local-small');
});

it('WeQ 缓存比本地文件新 → 直接用缓存里的 CDN 头像（不强制重拉）', async () => {
  mock.cachedAt.mockResolvedValue(Date.now());
  mock.localFile.mockResolvedValue({
    path: bigPath,
    variant: 'big',
    stale: false,
    mtimeMs: 1_000,
  });
  const response = await handleMediaRequest(new Request(bridge));
  expect(await response.text()).toBe('fresh');
  expect(mock.get).toHaveBeenCalledWith(upstream, 'avatar', undefined);
});
