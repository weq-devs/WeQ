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
  return { store, file, restart: () => new FixtureStore() };
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

it('候选版本复用未变化文件，下载与验证不改变活动路径；切换可回滚且重开可恢复', async () => {
  const { store, file, restart } = await fixture();
  await writeFile(file, bytes);
  const changed = Buffer.from('tokens');
  const model = {
    ...store.getModel('fixture')!,
    sizeBytes: 12,
    files: [
      { ...store.getModel('fixture')!.files[0]!, weight: 0.5 },
      {
        key: 'tokens',
        name: 'nested/tokens.bin',
        url: 'https://example.invalid/tokens',
        sizeBytes: 6,
        sha256: createHash('sha256').update(changed).digest('hex'),
        weight: 0.5,
      },
    ],
  };
  const revision = 'b'.repeat(64);
  const candidate = store.revisionStore(model, revision);
  await store.reuseInto(candidate, 'fixture');
  const fetcher = vi.fn(
    async () => new Response(changed, { headers: { 'content-length': '6', etag: '"tokens-v1"' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(await candidate.downloadModel('fixture')).toEqual({ success: true });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(await candidate.verifyModel('fixture')).toBe(true);
  expect(store.resolveModelPaths('fixture').model).toBe(file);
  const undo = store.activateRevision(candidate, 'fixture', revision);
  expect(store.resolveModelPaths('fixture').tokens).toContain(revision);
  expect(restart().resolveModelPaths('fixture').tokens).toContain(revision);
  // 模拟组件活动记录已更新、整包提交尚未完成的中断；提交点仍恢复原安装。
  const interrupted = restart();
  interrupted.restoreRevision('fixture', { revision: null });
  expect(interrupted.resolveModelPaths('fixture').model).toBe(file);
  undo();
  expect(store.resolveModelPaths('fixture').model).toBe(file);
  expect(restart().resolveModelPaths('fixture').model).toBe(file);
});

it('删除活动版本后不回退到保留的旧模型，重开仍卸载，显式重装可再次复用原件', async () => {
  const { store, file, restart } = await fixture();
  await writeFile(file, bytes);
  const model = store.getModel('fixture')!;
  const candidate = store.revisionStore(model, 'c'.repeat(64));
  await store.reuseInto(candidate, 'fixture');
  store.activateRevision(candidate, 'fixture', 'c'.repeat(64));
  expect(store.deleteModel('fixture')).toBe(true);
  expect(await readFile(file)).toEqual(bytes);
  expect(store.getModelStatus('fixture')?.downloaded).toBe(false);
  const reopened = restart();
  expect(reopened.getModelStatus('fixture')?.downloaded).toBe(false);
  const next = reopened.revisionStore(model, 'c'.repeat(64));
  await reopened.reuseInto(next, 'fixture');
  expect(await next.verifyModel('fixture')).toBe(true);
});

it('坏候选不阻碍复用已校验旧文件；同长度坏文件不计入可复用资源', async () => {
  const { store, file } = await fixture();
  await writeFile(file, bytes);
  const candidate = store.revisionStore(store.getModel('fixture')!, 'd'.repeat(64));
  const target = candidate.resolveModelPaths('fixture').model!;
  await mkdir(join(candidate.resolveModelDir('fixture'), 'nested'), { recursive: true });
  await writeFile(target, 'broken');
  expect(await store.reusableFiles(candidate, 'fixture')).toEqual(new Set(['model']));
  await store.reuseInto(candidate, 'fixture');
  expect(await readFile(target)).toEqual(bytes);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(await candidate.downloadModel('fixture')).toEqual({ success: true });
  expect(fetcher).not.toHaveBeenCalled();
  await writeFile(file, 'broken');
  await writeFile(target, 'broken');
  expect(await store.reusableFiles(candidate, 'fixture')).toEqual(new Set());
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
