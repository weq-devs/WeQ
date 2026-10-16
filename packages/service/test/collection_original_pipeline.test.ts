import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionService } from '../src/account/collection';
import { CollectionMediaStore, collectionMediaReferences } from '../src/account/collection_media';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(wrongMd5 = false, referencesOnly = false) {
  const root = mkdtempSync(join(tmpdir(), 'weq-original-pipeline-'));
  roots.push(root);
  const bytes = Buffer.from('synthetic file original');
  const descriptor = {
    fid: 'synthetic-fid',
    name: 'sample.txt',
    size: BigInt(bytes.length),
    md5: wrongMd5 ? Buffer.alloc(16) : createHash('md5').update(bytes).digest(),
  };
  const item = referencesOnly
    ? ({} as never)
    : ({
        summary: {
          fileSummary: { fileInfo: descriptor, srcFileInfo: { ...descriptor, name: 'source.txt' } },
        },
      } as never);
  const forbidden = vi.fn(() => {
    throw new Error('unexpected request');
  });
  const nt = {
    sendOidbPacket: forbidden,
    probePtLoginPort: forbidden,
    ptFetchSkey: forbidden,
    ptFetchPskey: forbidden,
  };
  const session = {
    context: { uin: '10001' },
    collection: {
      getByCid: async () => item,
      cachedContentByCids: async () =>
        referencesOnly
          ? new Map([
              [
                'cid',
                {
                  recordTime: 0,
                  richMediaContent: {
                    picList: [
                      {
                        uri: 'https://shp.qpic.cn/collector/synthetic/0',
                        name: 'picture.png',
                        size: bytes.length,
                        md5: createHash('md5').update(bytes).digest(),
                      },
                    ],
                  },
                },
              ],
            ])
          : new Map(),
    },
  } as never;
  return {
    root,
    bytes,
    item,
    forbidden,
    service: new CollectionService(nt as never, session, forbidden, root),
  };
}
describe('collection original acquisition service', () => {
  it('export acquires declared pictures as well as files and reuses their cache', async () => {
    const { service, bytes, forbidden } = setup(false, true);
    const fetch = vi.fn(
      async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await service.downloadExportMedia('cid')).toEqual({
      failed: 0,
      attempted: 1,
      stopRequests: false,
    });
    expect(await service.downloadExportMedia('cid')).toEqual({
      failed: 0,
      attempted: 0,
      stopRequests: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('stops an unsupported profile before credential or download dispatch', async () => {
    const { service, forbidden } = setup();
    expect(await service.downloadOriginalFiles('cid')).toEqual({
      failed: 1,
      attempted: 1,
      stopRequests: true,
    });
    expect(forbidden).not.toHaveBeenCalled();
    const entries = await service.exportCachedMedia(
      'cid',
      join(service.mediaCacheDirectory(), 'export'),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.receipt?.state).toBe('failed');
    expect(entries[1]?.receipt).toBeNull();
  });
  it('reuses original caches without requesting credentials and reports no new attempts', async () => {
    const { service, forbidden, item, bytes } = setup();
    const store = new CollectionMediaStore(service.mediaCacheDirectory());
    for (const reference of collectionMediaReferences('cid', null, item))
      await store.download(reference, {
        resolveDownload: async () => ({ url: 'https://download.weiyun.com/synthetic', cookie: '' }),
        fetch: async () => new Response(bytes),
      });
    expect(await service.downloadOriginalFiles('cid')).toEqual({
      failed: 0,
      attempted: 0,
      stopRequests: false,
    });
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('does not count cached mismatching candidates as verified originals', async () => {
    const { service, forbidden, item, bytes } = setup(true);
    const store = new CollectionMediaStore(service.mediaCacheDirectory());
    for (const reference of collectionMediaReferences('cid', null, item))
      await store.download(reference, {
        resolveDownload: async () => ({ url: 'https://download.weiyun.com/synthetic', cookie: '' }),
        fetch: async () => new Response(bytes),
      });
    expect(await service.downloadOriginalFiles('cid')).toEqual({
      failed: 2,
      attempted: 0,
      stopRequests: false,
    });
    expect(forbidden).not.toHaveBeenCalled();
  });
});
