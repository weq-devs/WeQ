import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelStore, type ModelDownloadProgress, type ModelEntry } from '../src/common/model_store';

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

it('多文件下载的状态和进度回调共用累计字节与固定总量，复用后续文件也不跳退', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-model-progress-'));
  roots.push(root);
  const files = [Buffer.alloc(6, 1), Buffer.alloc(3, 2), Buffer.alloc(2, 3)];
  class FixtureStore extends ModelStore<ModelEntry> {
    constructor() {
      super(root, [
        {
          id: 'bundle',
          sizeBytes: 11,
          files: files.map((data, index) => ({
            key: String(index),
            name: `${index}.bin`,
            url: `https://example.invalid/${index}`,
            // 故意不用字节权重，避免测试与实现共用未经验证的加权前提。
            weight: 1 / files.length,
            sizeBytes: data.length,
            sha256: createHash('sha256').update(data).digest('hex'),
          })),
        },
      ]);
    }
  }
  const store = new FixtureStore();
  await mkdir(store.resolveModelDir('bundle'));
  await writeFile(join(store.resolveModelDir('bundle'), '2.bin'), files[2]!);
  const fetcher = vi.fn(async (url: string) => {
    const data = files[Number(new URL(url).pathname.slice(1))]!;
    return new Response(data, { headers: { 'content-length': String(data.length), etag: '"v1"' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const progress: ModelDownloadProgress[] = [];
  let pausedBetweenFiles = false;
  store.on('progress', (event: ModelDownloadProgress) => {
    progress.push(event);
    if (
      !pausedBetweenFiles &&
      event.downloadedBytes === 8 &&
      existsSync(join(store.resolveModelDir('bundle'), '0.bin'))
    ) {
      pausedBetweenFiles = true;
      store.pauseDownload('bundle');
      store.continueDownload('bundle');
    }
  });
  expect(await store.downloadModel('bundle')).toEqual({ success: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(pausedBetweenFiles).toBe(true);
  expect(progress.some((event) => event.paused)).toBe(true);
  expect(progress.every((event) => event.totalBytes === 11)).toBe(true);
  expect(
    progress.every(
      (event, index) =>
        index === 0 || event.downloadedBytes >= progress[index - 1]!.downloadedBytes,
    ),
  ).toBe(true);
  for (const event of progress)
    expect(event.percent).toBeCloseTo((event.downloadedBytes / 11) * 100);
  expect(progress.some((event) => event.downloadedBytes === 8)).toBe(true);
  expect(progress.at(-1)).toMatchObject({ downloadedBytes: 11, percent: 100, done: true });
});

it('服务器忽略续传并从头返回时进度保持不回退，失败终态也保留已显示进度', async () => {
  const { store, file } = await fixture();
  await writeFile(`${file}.part`, bytes.subarray(0, 3));
  await writeFile(
    `${file}.resume.json`,
    JSON.stringify({
      url: 'https://example.invalid/model',
      validator: '"v1"',
      total: bytes.length,
    }),
  );
  const fetcher = vi.fn(
    async (_url: string, _options: { headers: Record<string, string> }) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 2));
            controller.enqueue(bytes.subarray(2));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-length': String(bytes.length), etag: '"v1"' } },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const progress: ModelDownloadProgress[] = [];
  store.on('progress', (event: ModelDownloadProgress) => progress.push(event));
  expect(await store.downloadModel('fixture')).toEqual({ success: true });
  expect(fetcher.mock.calls[0]![1].headers.Range).toBe('bytes=3-');
  expect(progress.some((event) => event.downloadedBytes === 3)).toBe(true);
  expect(
    progress.every(
      (event, index) =>
        index === 0 || event.downloadedBytes >= progress[index - 1]!.downloadedBytes,
    ),
  ).toBe(true);
  expect(await readFile(file)).toEqual(bytes);

  await rm(file);
  progress.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(bytes.subarray(0, 3), { headers: { 'content-length': String(bytes.length) } }),
    ),
  );
  expect((await store.downloadModel('fixture')).success).toBe(false);
  expect(progress.at(-1)).toMatchObject({
    downloadedBytes: 3,
    totalBytes: 6,
    percent: 50,
    error: expect.any(String),
  });
  expect(progress.some((event) => event.done)).toBe(false);
});
