/**
 * MediaCacheService 各子目录磁盘 TTL 的离线单测。
 *
 * avatar 缩短到 1 小时：本地 `nt_data/avatar` 文件优先，URL 磁盘缓存只是 CDN 兜底，
 * 短 TTL 让换头像后兜底图更快跟上；collection / linkpreview 仍 7 天，
 * dress / qqshow 仍 30 天。不联网、不碰真 QQ 数据库。
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaCacheService, ttlForSubdir } from '../src/bootstrap/media_cache';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('avatar 子目录 TTL 是 1 小时，其它子目录保持原值', () => {
  expect(ttlForSubdir('avatar')).toBe(HOUR);
  expect(ttlForSubdir('collection')).toBe(7 * DAY);
  expect(ttlForSubdir('linkpreview')).toBe(7 * DAY);
  expect(ttlForSubdir('dress')).toBe(30 * DAY);
  expect(ttlForSubdir('qqshow')).toBe(30 * DAY);
});

it('avatar 缓存超过 1 小时即失效并重新拉取，collection 7 天内仍命中', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-media-ttl-'));
  roots.push(root);
  // 与 UserConfigService.cacheDir 一样，取目录时顺手建好（缓存写入不会自己 mkdir）。
  const cache = new MediaCacheService({
    cacheDir: (subdir) => {
      const dir = join(root, subdir);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  });
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response('fresh', { headers: { 'content-type': 'image/png' } }),
    );
  vi.stubGlobal('fetch', fetcher);

  const avatarUrl = 'https://thirdqq.qlogo.cn/g?b=sdk&nk=10001&s=0';
  const collectionUrl = 'https://p.qpic.cn/collection/1.png';

  // 先写入两个子目录的缓存，再把 mtime 拨到 2 小时前。
  await cache.get(avatarUrl, 'avatar');
  await cache.get(collectionUrl, 'collection');
  const stale = new Date(Date.now() - 2 * HOUR);
  for (const [url, subdir] of [
    [avatarUrl, 'avatar'],
    [collectionUrl, 'collection'],
  ] as const) {
    const hash = createHash('sha1').update(url).digest('hex');
    await utimes(join(root, subdir, `${hash}.png`), stale, stale);
  }

  // avatar 过期 → 重新请求；collection 仍在 7 天内 → 直接命中磁盘。
  expect((await cache.get(avatarUrl, 'avatar')).data.toString()).toBe('fresh');
  expect(fetcher).toHaveBeenCalledTimes(3);

  const hit = await cache.get(collectionUrl, 'collection');
  expect(hit.fromCache).toBe(true);
  expect(hit.data.toString()).toBe('fresh');
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('avatar 缓存 30 分钟内仍命中，不重复请求', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-media-ttl-hit-'));
  roots.push(root);
  // 与 UserConfigService.cacheDir 一样，取目录时顺手建好（缓存写入不会自己 mkdir）。
  const cache = new MediaCacheService({
    cacheDir: (subdir) => {
      const dir = join(root, subdir);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  });
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response('fresh', { headers: { 'content-type': 'image/png' } }),
    );
  vi.stubGlobal('fetch', fetcher);

  const url = 'https://thirdqq.qlogo.cn/g?b=sdk&nk=10002&s=0';
  await cache.get(url, 'avatar');
  const recent = new Date(Date.now() - 30 * 60 * 1000);
  const hash = createHash('sha1').update(url).digest('hex');
  await utimes(join(root, 'avatar', `${hash}.png`), recent, recent);

  const hit = await cache.get(url, 'avatar');
  expect(hit.fromCache).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
