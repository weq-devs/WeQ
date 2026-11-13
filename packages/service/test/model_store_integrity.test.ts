import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelStore, type ModelEntry } from '../src/common/model_store';

const bytes = Buffer.from('golden');
const digest = createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weq-model-integrity-'));
  roots.push(root);
  class FixtureStore extends ModelStore<ModelEntry> {
    constructor() {
      super(root, [
        {
          id: 'fixture',
          sizeBytes: bytes.length,
          files: [
            {
              key: 'model',
              name: 'nested/model.bin',
              url: 'https://example.invalid/model',
              weight: 1,
              sizeBytes: bytes.length,
              sha256: digest,
            },
          ],
        },
      ]);
    }
  }
  const store = new FixtureStore();
  const file = store.resolveModelPaths('fixture').model!;
  await mkdir(join(store.resolveModelDir('fixture'), 'nested'), { recursive: true });
  return { store, file };
}

it('复用经过哈希校验的完整旧文件，不重新下载', async () => {
  const { store, file } = await fixture();
  await writeFile(file, bytes);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(await store.verifyModel('fixture')).toBe(true);
  expect(await store.downloadModel('fixture')).toEqual({ success: true });
  expect(fetcher).not.toHaveBeenCalled();
});

it('同长度坏文件不能通过校验；显式重试原子替换且并发不重复下载', async () => {
  const { store, file } = await fixture();
  await writeFile(file, 'broken');
  expect(await store.verifyModel('fixture')).toBe(false);
  const fetcher = vi.fn(
    async () =>
      new Response(bytes, { headers: { 'content-length': String(bytes.length), etag: '"v1"' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(
    await Promise.all([store.downloadModel('fixture'), store.downloadModel('fixture')]),
  ).toEqual([{ success: true }, { success: true }]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await readFile(file)).toEqual(bytes);
});

it('中断保留带资源身份的分段；重试验证 Range 后续传，再检查最终哈希', async () => {
  const { store, file } = await fixture();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(bytes.subarray(0, 3), {
        headers: { 'content-length': String(bytes.length), etag: '"v1"' },
      }),
    )
    .mockResolvedValueOnce(
      new Response(bytes.subarray(3), {
        status: 206,
        headers: { 'content-length': '3', 'content-range': 'bytes 3-5/6', etag: '"v1"' },
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  expect((await store.downloadModel('fixture')).success).toBe(false);
  expect(await readFile(`${file}.part`)).toEqual(bytes.subarray(0, 3));
  expect(await store.downloadModel('fixture')).toEqual({ success: true });
  expect(fetcher.mock.calls[1]![1].headers.Range).toBe('bytes=3-');
  expect(await readFile(file)).toEqual(bytes);
});

it('HTTP 416、坏哈希和同名目录均不能发布成功回执', async () => {
  const { store, file } = await fixture();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 416 }))
    .mockResolvedValueOnce(
      new Response(Buffer.from('broken'), { headers: { 'content-length': '6' } }),
    );
  vi.stubGlobal('fetch', fetcher);
  expect((await store.downloadModel('fixture')).success).toBe(false);
  expect((await store.downloadModel('fixture')).success).toBe(false);
  expect(store.getModelStatus('fixture')!.downloaded).toBe(false);
  await mkdir(file);
  expect(store.getModelStatus('fixture')!.downloaded).toBe(false);
  expect(await store.verifyModel('fixture')).toBe(false);
});
