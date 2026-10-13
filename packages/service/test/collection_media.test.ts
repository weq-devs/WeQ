import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CollectionMediaStore,
  collectionMediaReferences,
  collectionMediaUrl,
  type CollectionMediaReference,
} from '../src/account/collection_media';

const bytes = Buffer.from('synthetic-original-media');
const md5 = createHash('md5').update(bytes).digest('hex');
const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'weq-collection-media-'));
  roots.push(root);
  const [ref] = collectionMediaReferences('synthetic-cid', {
    recordTime: 0,
    richMediaContent: {
      picList: [
        {
          uri: 'https://shp.qpic.cn/collector/synthetic/0',
          name: 'picture.png',
          md5: Buffer.from(md5, 'hex'),
          size: bytes.length,
        },
      ],
    },
  });
  return { root, store: new CollectionMediaStore(root), ref: ref! };
}
const response = () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('collection attachment references', () => {
  it('binds inline references to unambiguous exact declarations without collapsing pointers', () => {
    const uri = 'https://shp.qpic.cn/synthetic/0';
    const refs = collectionMediaReferences('cid', {
      recordTime: 0,
      richMediaContent: {
        picList: [{ uri, md5: Buffer.from(md5, 'hex'), size: bytes.length }],
        rawData: `<img src="${uri}">`,
      },
    });
    expect(refs).toHaveLength(2);
    expect(refs[1]).toMatchObject({
      expectedMd5: md5,
      expectedSize: String(bytes.length),
      sourceRole: 'original-candidate',
    });
    expect(refs[0]?.id).not.toBe(refs[1]?.id);
  });
  it('keeps original candidates, inline references, native files and preview covers distinct', () => {
    const refs = collectionMediaReferences(
      'synthetic-cid',
      {
        recordTime: 0,
        richMediaContent: {
          rawData:
            '<img src="https://shp.qpic.cn/inline/0"><audio src="https://qq.com/synthetic.silk"></audio>',
          fileList: [
            {
              name: 'record.txt',
              md5: Buffer.from(md5, 'hex'),
              size: BigInt(bytes.length),
              fid: 'synthetic-fid',
            },
          ],
        },
      },
      { summary: { videoSummary: { previewPicInfo: { uri: 'https://qpic.cn/cover' } } } } as never,
    );
    expect(refs.map((ref) => [ref.kind, ref.sourceRole])).toEqual([
      ['file', 'original-candidate'],
      ['image', 'preview'],
      ['image', 'unknown'],
      ['audio', 'unknown'],
    ]);
    expect(refs[0]).toMatchObject({
      uri: null,
      expectedMd5: md5,
      expectedSize: String(bytes.length),
    });
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(refs.length);
    expect(
      collectionMediaReferences('other-cid', {
        recordTime: 0,
        richMediaContent: { fileList: [{ name: 'record.txt' }] },
      })[0]?.id,
    ).not.toBe(refs[0]?.id);
  });

  it.each([
    'http://127.0.0.1/file',
    'https://qq.com.evil.invalid/file',
    'https://user:secret@qq.com/file',
    'file:///private/file',
    'https://qq.com:9443/file',
    'https://qq.com/\nfile',
  ])('rejects non-resource URLs: %s', (url) => {
    expect(() => collectionMediaUrl(url)).toThrow();
  });
});

describe('collection attachment downloads', () => {
  it('streams bytes, verifies identities, decodes images, and reuses a checked durable cache', async () => {
    const { root, store, ref } = setup();
    const fetchMock = vi.fn(async () => response());
    const result = await store.download(ref, {
      fetch: fetchMock,
      inspectImage: async () => ({ width: 2, height: 3 }),
    });
    expect(result).toMatchObject({
      state: 'downloaded',
      role: 'original',
      bytes: bytes.length,
      md5,
      md5Matches: true,
      sizeMatches: true,
      imageDecoded: true,
    });
    expect(readFileSync(join(root, result.file!))).toEqual(bytes);
    expect(JSON.parse(readFileSync(join(root, 'receipts', `${ref.id}.json`), 'utf8')).sha256).toBe(
      result.sha256,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
      headers: { 'Accept-Encoding': 'identity' },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Cookie');
    const reopened = new CollectionMediaStore(root);
    expect((await reopened.download(ref, { fetch: fetchMock })).role).toBe('original');
    expect(fetchMock).toHaveBeenCalledOnce();
    writeFileSync(join(root, result.file!), 'damaged');
    expect(
      (
        await reopened.download(ref, {
          fetch: fetchMock,
          inspectImage: async () => ({ width: 2, height: 3 }),
        })
      ).md5,
    ).toBe(md5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readdirSync(join(root, 'files')).some((name) => name.endsWith('.partial'))).toBe(false);
  });

  it.each([
    [{ expectedMd5: '0'.repeat(32) }, 'unverified'],
    [{ expectedSize: '1' }, 'unverified'],
    [{ sourceRole: 'preview' }, 'preview'],
    [{ expectedMd5: null }, 'unverified'],
  ])('does not call mismatched, undeclared or cover bytes originals', async (patch, role) => {
    const { store, ref } = setup();
    const result = await store.download({ ...ref, ...patch } as CollectionMediaReference, {
      fetch: async () => response(),
      inspectImage: async () => ({ width: 2, height: 3 }),
    });
    expect(result).toMatchObject({ state: 'downloaded', role });
  });

  it('keeps an undecodable image unverified despite matching MD5 and size', async () => {
    const { store, ref } = setup();
    expect(
      await store.download(ref, { fetch: async () => response(), inspectImage: async () => null }),
    ).toMatchObject({ role: 'unverified', imageDecoded: false });
  });

  it('records a native-only file as uncovered without sending any request', async () => {
    const { store, ref } = setup();
    const fetchMock = vi.fn();
    const result = await store.download({ ...ref, uri: null, kind: 'file' }, { fetch: fetchMock });
    expect(result).toMatchObject({ state: 'unavailable', file: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([302, 404, 429])(
    'does not follow redirects or publish HTTP %s as success',
    async (status) => {
      const { store, ref } = setup();
      const result = await store.download(ref, {
        fetch: async () => new Response('', { status, headers: { location: 'http://127.0.0.1/' } }),
      });
      expect(result).toMatchObject({ state: 'failed', file: null });
    },
  );

  it('rejects oversized and truncated streams and cleans temporary files', async () => {
    const { root, store, ref } = setup();
    expect(
      await store.download(ref, { maxBytes: 2, fetch: async () => new Response(bytes) }),
    ).toMatchObject({ state: 'failed', file: null });
    expect(
      await store.download(ref, {
        fetch: async () => new Response(bytes, { headers: { 'content-length': '100' } }),
      }),
    ).toMatchObject({ state: 'failed', file: null });
    expect(readdirSync(join(root, 'files'))).toEqual([]);
  });

  it('cancels an unresponsive transport without advancing a receipt', async () => {
    const { root, store, ref } = setup();
    const controller = new AbortController();
    const pending = store.download(ref, {
      signal: controller.signal,
      fetch: () => new Promise(() => {}),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
    expect(readdirSync(root)).toEqual([]);
  });

  it('times out an unresponsive transport and records failure', async () => {
    const { store, ref } = setup();
    expect(
      await store.download(ref, { timeoutMs: 10, fetch: () => new Promise(() => {}) }),
    ).toMatchObject({ state: 'failed', file: null, error: '收藏附件下载超时。' });
  });

  it('closes a response arriving after timeout without publishing its bytes', async () => {
    const { root, store, ref } = setup();
    let resolve!: (response: Response) => void;
    const result = await store.download(ref, {
      timeoutMs: 5,
      fetch: () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    });
    expect(result).toMatchObject({ state: 'failed', file: null });
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(readdirSync(root)).not.toContain('files');
  });

  it('settles a stalled download even when stream cancellation never settles', async () => {
    const { root, store, ref } = setup();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const result = await store.download(ref, {
      timeoutMs: 20,
      fetch: async () => new Response(new ReadableStream({ cancel })),
    });
    expect(result).toMatchObject({ state: 'failed', file: null, error: '收藏附件下载超时。' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(readdirSync(join(root, 'files'))).toEqual([]);
  });

  it('returns HTTP failure without waiting indefinitely for an unused body to cancel', async () => {
    const { store, ref } = setup();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const result = await store.download(ref, {
      fetch: async () => new Response(new ReadableStream({ cancel }), { status: 403 }),
    });
    expect(result).toMatchObject({
      state: 'failed',
      file: null,
      error: '附件下载失败（HTTP 403）。',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('copies only hash-checked cached bytes into an export and reports damaged originals as failed', async () => {
    const { root, store, ref } = setup();
    const result = await store.download(ref, {
      fetch: async () => response(),
      inspectImage: async () => ({ width: 2, height: 3 }),
    });
    const directory = join(root, 'bundle', 'media');
    const exported = await store.exportCached(ref, directory);
    expect(exported.receipt?.role).toBe('original');
    expect(readFileSync(join(directory, exported.file!))).toEqual(bytes);
    writeFileSync(join(root, result.file!), 'damaged');
    const damaged = await store.exportCached(ref, join(root, 'other-bundle'));
    expect(damaged).toMatchObject({ file: null, receipt: { state: 'failed', role: 'unverified' } });
  });

  it('reuses identical resources while keeping separate source receipts', async () => {
    const { root, store, ref } = setup();
    const fetchMock = vi.fn(async () => response());
    await store.download(ref, {
      fetch: fetchMock,
      inspectImage: async () => ({ width: 1, height: 1 }),
    });
    const alias = { ...ref, id: 'a'.repeat(64), pointer: 'html/1' };
    expect((await store.download(alias, { fetch: fetchMock })).role).toBe('original');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readdirSync(join(root, 'receipts'))).toHaveLength(2);
  });

  it('saves a checked cached attachment under its original name without fetching again', async () => {
    const { root, store, ref } = setup();
    const fetchMock = vi.fn(async () => response());
    await store.download(ref, {
      fetch: fetchMock,
      inspectImage: async () => ({ width: 1, height: 1 }),
    });
    expect((await store.savedFile(ref.id)).name).toBe('picture.png');
    const target = join(root, 'saved.png');
    await store.saveAs(ref.id, target);
    expect(readFileSync(target)).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readdirSync(root).some((name) => name.endsWith('.partial'))).toBe(false);
  });
});
