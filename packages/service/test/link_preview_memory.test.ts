import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import type { Platform } from '@weq/platform';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LinkPreviewService,
  LINK_PREVIEW_CACHE_LIMITS,
  type LinkPreview,
} from '../src/bootstrap/link_preview';
import { UserConfigService } from '../src/bootstrap/user_config';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
}));
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(limits = { maxEntries: 3, maxBytes: 16_384 }) {
  const root = mkdtempSync(join(tmpdir(), 'weq-link-memory-'));
  roots.push(root);
  const config = new UserConfigService({ appDataRoot: () => root } as Platform);
  const service = new LinkPreviewService(config, limits);
  const seed = (url: string, title = '合成预览', fetchedAt = Date.now()) => {
    const preview: LinkPreview = {
      url,
      title,
      desc: '',
      siteName: '合成站点',
      image: '',
      imageKind: '',
      fetchedAt,
    };
    const dir = config.cacheDir('linkpreview');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${createHash('sha1').update(url).digest('hex')}.json`),
      JSON.stringify({ preview, fetchedAt }),
    );
    return preview;
  };
  return { service, seed, config };
}

it('无效内存预算明确拒绝，不会意外成为无界缓存', () => {
  const { config } = fixture();
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    expect(() => new LinkPreviewService(config, { maxEntries: value })).toThrow();
    expect(() => new LinkPreviewService(config, { maxBytes: value })).toThrow();
  }
});

it('多项合计达到字节预算时也会 LRU 淘汰，而非只限制条目数', async () => {
  const { service, seed } = fixture({ maxEntries: 10, maxBytes: 800 });
  const a = seed('https://synthetic.invalid/a', 'a'.repeat(30));
  const b = seed('https://synthetic.invalid/b', 'b'.repeat(30));
  await service.get(a.url);
  expect(service.memoryDiagnostics().entries).toBe(1);
  await service.get(b.url);
  expect(service.memoryDiagnostics()).toMatchObject({ entries: 1, evictions: 1 });
  expect(service.memoryDiagnostics().bytes).toBeLessThanOrEqual(800);
  expect(lookup).not.toHaveBeenCalled();
});

it('成功缓存保留原长 TTL，损坏缓存视为可重建派生数据', async () => {
  vi.useFakeTimers();
  const { service, seed, config } = fixture();
  const preview = seed('https://synthetic.invalid/success');
  await service.get(preview.url);
  vi.setSystemTime(
    Date.now() + LINK_PREVIEW_CACHE_LIMITS.failureTtlMs + LINK_PREVIEW_CACHE_LIMITS.sweepMs,
  );
  expect(await service.get(preview.url)).toEqual(preview);
  expect(lookup).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + LINK_PREVIEW_CACHE_LIMITS.successTtlMs);
  expect(await service.get(preview.url)).toBeNull();
  const invalid = 'https://synthetic.invalid/invalid';
  writeFileSync(
    join(
      config.cacheDir('linkpreview'),
      `${createHash('sha1').update(invalid).digest('hex')}.json`,
    ),
    JSON.stringify({ fetchedAt: Date.now(), preview: { title: 'invalid' } }),
  );
  expect(await service.get(invalid)).toBeNull();
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('大量不同失败 URL 的内存项数与字节均有界，同 URL 并发仍只抓一次', async () => {
  const { service } = fixture();
  for (let i = 0; i < 100; i++) await service.get(`https://synthetic.invalid/${i}`);
  expect(service.memoryDiagnostics().entries).toBeLessThanOrEqual(3);
  expect(service.memoryDiagnostics().bytes).toBeLessThanOrEqual(16_384);
  vi.mocked(lookup).mockClear();
  await Promise.all(
    Array.from({ length: 10 }, () => service.get('https://synthetic.invalid/shared')),
  );
  expect(lookup).toHaveBeenCalledOnce();
});

it('LRU 淘汰不删除磁盘结果，带不同查询参数的 URL 仍分别命中，不增加出网', async () => {
  const { service, seed } = fixture({ maxEntries: 2, maxBytes: 16_384 });
  const urls = [
    'https://synthetic.invalid/?p=1',
    'https://synthetic.invalid/?p=2',
    'https://synthetic.invalid/?p=3',
  ];
  const values = urls.map((url, i) => seed(url, `标题${i}`));
  await service.get(urls[0]!);
  await service.get(urls[1]!);
  await service.get(urls[0]!);
  await service.get(urls[2]!);
  expect(service.memoryDiagnostics()).toMatchObject({ entries: 2, evictions: 1 });
  expect(await service.get(urls[1]!)).toEqual(values[1]);
  expect(lookup).not.toHaveBeenCalled();
});

it('超出字节预算的单项仍可从磁盘读取，调用方不能通过修改返回值撑大缓存', async () => {
  const { service, seed } = fixture({ maxEntries: 3, maxBytes: 1024 });
  const large = seed('https://synthetic.invalid/large', 'x'.repeat(2048));
  expect(await service.get(large.url)).toEqual(large);
  expect(service.memoryDiagnostics()).toMatchObject({ entries: 0, bytes: 0 });
  const small = seed('https://synthetic.invalid/small', 'small');
  const result = await service.get(small.url);
  result!.title = 'mutated'.repeat(1000);
  expect((await service.get(small.url))!.title).toBe('small');
  expect(service.memoryDiagnostics().bytes).toBeLessThanOrEqual(1024);
  expect(lookup).not.toHaveBeenCalled();
});

it('过期失败条目按原 TTL 重试，新访问会回收过期内存条目', async () => {
  vi.useFakeTimers();
  const { service } = fixture();
  const url = 'https://synthetic.invalid/failed';
  await service.get(url);
  await service.get(url);
  expect(lookup).toHaveBeenCalledOnce();
  vi.setSystemTime(
    Date.now() + LINK_PREVIEW_CACHE_LIMITS.failureTtlMs + LINK_PREVIEW_CACHE_LIMITS.sweepMs,
  );
  await service.get('https://synthetic.invalid/new');
  expect(service.memoryDiagnostics().entries).toBe(1);
  await service.get(url);
  expect(lookup).toHaveBeenCalledTimes(3);
});
