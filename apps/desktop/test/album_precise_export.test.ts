// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { exportSelectedQzoneAlbums } from '../src/main/ipc/routers/account';
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
