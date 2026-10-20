import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaCacheService } from '../src/bootstrap/media_cache';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('显式刷新失败保留旧图，成功换格式后不再命中旧扩展名', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-avatar-refresh-'));
  roots.push(root);
  const cache = new MediaCacheService({ cacheDir: () => root });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('old', { headers: { 'content-type': 'image/png' } }));
  vi.stubGlobal('fetch', fetcher);
  const url = 'https://p.qlogo.cn/gh/123/123/0';
  await cache.get(url);
  fetcher.mockRejectedValueOnce(new Error('offline'));
  await expect(cache.get(url, 'avatar', 0)).rejects.toThrow('offline');
  expect((await cache.get(url)).data.toString()).toBe('old');
  fetcher.mockResolvedValueOnce(new Response('new', { headers: { 'content-type': 'image/jpeg' } }));
  expect((await cache.get(url, 'avatar', 0)).data.toString()).toBe('new');
  const cached = await cache.get(url);
  expect(cached.data.toString()).toBe('new');
  expect(cached.contentType).toBe('image/jpeg');
  expect(cached.fromCache).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
