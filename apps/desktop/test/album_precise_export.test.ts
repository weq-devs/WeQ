// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
  exportSelectedQzoneAlbums,
  runResumableAlbumResource,
} from '../src/main/ipc/routers/account';
import { ExportCheckpoint } from '@weq/service/export-checkpoint';
import type { AccountServices } from '../src/main/context/app_context';
vi.mock('../src/main/context/app_context', () => {
  const context = () => ({
    account: { context: {} },
    bootstrap: {
      ocrModels: { listByKind: () => [] },
      userConfig: {
        getSettings: () => ({ autoAttachQq: true, ocr: { prefilterEnabled: false } }),
        getLocalModelId: () => null,
      },
    },
  });
  return {
    getAppContext: context,
    requireBootstrap: () => context().bootstrap,
    accountEventBus: new EventEmitter(),
  };
});

it('相册导出暂停后复用完成的相册，断点文件不符时拒绝发布', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-reopen-album-'));
  const directory = join(root, 'files');
  const first = new AbortController();
  const fetcher = vi.fn(
    async () => new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/jpeg' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  const pages = vi.fn(async (_uid: string, id: string) => {
    if (id === 'second') first.abort();
    return {
      totalInAlbum: 1,
      photos: [{ id, picKey: id, url: `https://fixture.invalid/${id}.jpg`, isVideo: false }],
    };
  });
  const services = {
    accountConfig: { getRecord: () => ({ qqOnline: true, qqPid: 1 }) },
    webQuery: { getQzoneAlbumPhotos: pages },
  } as unknown as AccountServices;
  const request = {
    type: 'qzone-albums' as const,
    hostUin: '10002',
    albums: [{ id: 'first' }, { id: 'second' }],
  };
  const work = (signal: AbortSignal) =>
    runResumableAlbumResource(
      services,
      request,
      {
        signal,
        directory,
        checkpoint: new ExportCheckpoint(join(root, 'checkpoint'), signal),
        progress() {},
      },
      () => {},
    );
  try {
    await expect(work(first.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    const folder = join(directory, '相册_first');
    const path = join(folder, (await readdir(folder))[0]!);
    const original = await readFile(path);
    await writeFile(path, 'changed');
    await expect(work(new AbortController().signal)).rejects.toThrow('发生变化');
    await writeFile(path, original);
    expect(await work(new AbortController().signal)).toMatchObject({ total: 2, ok: 2, failed: [] });
    expect(pages.mock.calls.map(([, album]) => album)).toEqual(['first', 'second', 'second']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
afterEach(() => vi.unstubAllGlobals());
it('实际相册导出器只下载离散媒体，分页重复不重复保存，失效项不扩大范围', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-exact-album-'));
  const photos = [
    {
      picKey: 'keep',
      id: 'one',
      name: 'same-name',
      url: 'https://fixture.invalid/keep.jpg',
      isVideo: false,
    },
    {
      picKey: 'skip',
      id: 'two',
      name: 'same-name',
      url: 'https://fixture.invalid/skip.jpg',
      isVideo: false,
    },
  ];
  const fetcher = vi.fn(
    async () => new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/jpeg' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  const pages = vi.fn(async () => ({ photos, totalInAlbum: 4 }));
  const services = {
    accountConfig: { getRecord: () => ({ qqOnline: true, qqPid: 1 }) },
    webQuery: { getQzoneAlbumPhotos: pages },
  } as unknown as AccountServices;
  try {
    const result = await exportSelectedQzoneAlbums(
      services,
      {
        hostUin: '10002',
        albums: [{ id: 'album-a', title: '甲', mediaKeys: ['keep', 'missing'] }],
        outputDir: root,
      },
      { signal: new AbortController().signal, check() {}, progress() {} },
    );
    expect(result).toMatchObject({
      total: 2,
      ok: 1,
      failed: [{ fileName: expect.stringContaining('missing') }],
    });
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(pages).toHaveBeenCalledTimes(2);
    expect(result.failed[0]?.error).toContain('分页重复');
    expect(fetcher).toHaveBeenCalledWith('https://fixture.invalid/keep.jpg', expect.anything());
    const folders = await readdir(root);
    expect(await readdir(join(root, folders[0]!))).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
