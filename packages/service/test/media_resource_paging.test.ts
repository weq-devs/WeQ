import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaResourceService } from '../src/account/media_resource';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, lstat: vi.fn(fs.lstat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weq-resource-page-'));
  roots.push(root);
  const service = new MediaResourceService(
    { context: { uin: 'fixture' } } as AccountSession,
    {
      ntDataDir: () => root,
      picDir: () => join(root, 'Pic'),
      pttDir: () => join(root, 'Ptt'),
    } as Platform,
  );
  const put = async (relative: string, seconds: number, bytes = 'fixture') => {
    const name = join(root, relative);
    await mkdir(dirname(name), { recursive: true });
    await writeFile(name, bytes);
    await utimes(name, seconds, seconds);
  };
  return { root, service, put };
}

it('平面缓存只给本页文件读元数据，能够跨桶继续翻页', async () => {
  const f = await fixture();
  await Promise.all(
    ['aa/c', 'aa/a', 'aa/b', 'bb/a', 'bb/b'].map((name) => f.put(`Qzone/${name}`, 600)),
  );
  const first = await f.service.listFlat('qzone', { limit: 2 });
  expect(first.entries.map((entry) => entry.rel)).toEqual(['aa/a', 'aa/b']);
  expect(lstat).toHaveBeenCalledTimes(2);
  const middle = await f.service.listFlat('qzone', { limit: 2, cursor: first.nextCursor });
  expect(middle.entries.map((entry) => entry.rel)).toEqual(['aa/c', 'bb/a']);
  expect(lstat).toHaveBeenCalledTimes(4);
  const last = await f.service.listFlat('qzone', { limit: 2, cursor: middle.nextCursor });
  expect(last.entries.map((entry) => entry.rel)).toEqual(['bb/b']);
  expect(last.nextCursor).toBeNull();
});

it('按月合并选择正确的变体，继续翻页复用顺序，目录改动和首屏重开可刷新', async () => {
  const f = await fixture();
  await Promise.all([
    f.put('Pic/2026-10/Ori/a.jpg', 10, 'older'),
    f.put('Pic/2026-10/Ori/a.png', 20, 'newer original'),
    f.put('Pic/2026-10/Thumb/a_0.jpg', 15, 'preferred'),
    f.put('Pic/2026-10/Thumb/a_720.jpg', 50),
    f.put('Pic/2026-10/Ori/b.jpg', 30),
    f.put('Pic/2026-09/Ori/historical.jpg', 80),
  ]);
  const first = await f.service.listMonth('pic', { limit: 1 });
  expect(first.entries[0]).toMatchObject({
    hash: 'a',
    oriRel: '2026-10/Ori/a.png',
    thumbRel: '2026-10/Thumb/a_0.jpg',
    mtimeMs: 50_000,
    ext: 'png',
  });
  vi.mocked(lstat).mockClear();
  const next = await f.service.listMonth('pic', { limit: 1, cursor: first.nextCursor });
  expect(next.entries[0]?.hash).toBe('b');
  expect(lstat).toHaveBeenCalledTimes(2);
  expect(
    (await f.service.listMonth('pic', { limit: 1, cursor: next.nextCursor })).entries[0]?.hash,
  ).toBe('historical');

  await f.put('Pic/2026-10/Ori/c.jpg', 25);
  await utimes(join(f.root, 'Pic/2026-10/Ori'), 100, 100);
  const edited = await f.service.listMonth('pic', { limit: 2, cursor: first.nextCursor });
  expect(edited.entries.map((entry) => entry.hash)).toEqual(['b', 'c']);
  await f.put('Pic/2026-10/Ori/c.jpg', 60, 'resized bytes');
  const reopened = await f.service.listMonth('pic', { limit: 1 });
  expect(reopened.entries[0]).toMatchObject({ hash: 'c', oriBytes: 13, mtimeMs: 60_000 });
});

it('隐藏页面时停止发出更多文件读取，回到语音页后可完整分页', async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.put(`Ptt/2026-10/Ori/${i}.amr`, i + 1)));
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const opened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let files = 0;
  const signal = new AbortController();
  vi.mocked(lstat).mockImplementation((async (path, opts) => {
    if (String(path).endsWith('.amr')) {
      files++;
      opened.resolve();
      await release.promise;
    }
    return fs.lstat(path, opts);
  }) as typeof lstat);
  try {
    const result = expect(f.service.listVoice({ signal: signal.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await opened.promise;
    signal.abort();
    release.resolve();
    await result;
    expect(files).toBeGreaterThan(0);
    expect(files).toBeLessThan(20);
  } finally {
    vi.mocked(lstat).mockImplementation(fs.lstat);
  }
  const first = await f.service.listVoice({ limit: 4 });
  expect(first.entries.map((entry) => entry.hash)).toEqual(['19', '18', '17', '16']);
  vi.mocked(lstat).mockClear();
  const second = await f.service.listVoice({ limit: 4, cursor: first.nextCursor });
  expect(second.entries.map((entry) => entry.hash)).toEqual(['15', '14', '13', '12']);
  expect(lstat).toHaveBeenCalledOnce();
});
