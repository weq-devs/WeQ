// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelStore, type ModelEntry } from '@weq/service';
import { afterEach, expect, it, vi } from 'vitest';
import { createModelComponent } from '../src/main/enhancements/model_component';
import { EnhancementPacks } from '../src/main/enhancements/packs';
import { modelReleaseComponent } from '../src/main/enhancements/release_catalog';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weq-partial-model-'));
  roots.push(root);
  const data = [Buffer.from('model'), Buffer.from('words')];
  const model: ModelEntry = {
    id: 'sensevoice',
    sizeBytes: 10,
    files: data.map((bytes, index) => ({
      key: String(index),
      name: `${index}.bin`,
      url: `https://example.invalid/${index}`,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      weight: 0.5,
    })),
  };
  class Store extends ModelStore<ModelEntry> {
    constructor() {
      super(root, [model], { retryBaseMs: 0 });
    }
  }
  const store = new Store();
  await mkdir(store.resolveModelDir(model.id));
  const item = createModelComponent(store, model.id);
  const validate = vi.fn(async () => {});
  const packs = new EnhancementPacks(
    [{ id: 'voice', name: '语音', description: '', components: [item.component.id], validate }],
    new Map([[item.component.id, item.component]]),
    join(root, 'enhancements'),
  );
  return { root, data, model, store, item, packs, validate };
}

it('部分模型仅下载缺失文件；失败保留旧文件，重试复用成功候选再切换', async () => {
  const f = await fixture();
  const oldPath = f.store.resolveModelPaths('sensevoice')['0']!;
  await writeFile(oldPath, f.data[0]!);
  const fetcher = vi.fn(async (url: string) => {
    expect(new URL(url).pathname).toBe('/1');
    return new Response(f.data[1]!, { headers: { 'content-length': '5' } });
  });
  vi.stubGlobal('fetch', fetcher);
  expect((await f.packs.list())[0]).toMatchObject({
    installed: false,
    sizeOnDisk: 5,
    downloadBytes: 5,
  });
  f.validate.mockRejectedValueOnce(new Error('candidate cannot load'));
  f.packs.start(['voice']);
  await f.packs.wait();
  expect((await f.packs.list())[0]?.operation).toMatchObject({ phase: 'failed' });
  expect(f.store.resolveModelPaths('sensevoice')['0']).toBe(oldPath);
  expect(await readFile(oldPath)).toEqual(f.data[0]);
  expect(fetcher).toHaveBeenCalledOnce();
  f.packs.start(['voice']);
  await f.packs.wait();
  expect(fetcher).toHaveBeenCalledOnce();
  expect((await f.packs.list())[0]).toMatchObject({ ready: true, downloadBytes: 0 });
  expect(f.store.resolveModelPaths('sensevoice')['0']).not.toBe(oldPath);
});

it('同长度坏文件列为缺项，校验通过的另一文件复用，轮询不重复读取全部哈希', async () => {
  const f = await fixture();
  await writeFile(f.store.resolveModelPaths('sensevoice')['0']!, 'wrong');
  await writeFile(f.store.resolveModelPaths('sensevoice')['1']!, f.data[1]!);
  const verify = vi.spyOn(f.store, 'verifyModel');
  expect((await f.packs.list())[0]).toMatchObject({
    downloaded: false,
    downloadBytes: 5,
    sizeOnDisk: 10,
  });
  await f.packs.list();
  expect(verify).toHaveBeenCalledOnce();
  const fetcher = vi.fn(
    async () => new Response(f.data[0]!, { headers: { 'content-length': '5' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  f.packs.start(['voice']);
  await f.packs.wait();
  expect(fetcher).toHaveBeenCalledOnce();
  expect((await f.packs.list())[0]?.ready).toBe(true);
});

it('新增文件候选下载失败时旧完整能力仍可用，成功校验前不换路径', async () => {
  const f = await fixture();
  for (const [index, bytes] of f.data.entries())
    await writeFile(f.store.resolveModelPaths('sensevoice')[String(index)]!, bytes);
  const oldDirectory = f.store.resolveModelDir('sensevoice');
  const next = structuredClone(f.model);
  next.files.push({
    ...next.files[0]!,
    key: 'extra',
    name: 'extra.bin',
    url: 'https://example.invalid/extra',
    sha256: 'a'.repeat(64),
  });
  f.item.component.select!(modelReleaseComponent(next));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  f.packs.start(['voice']);
  await f.packs.wait();
  expect(f.store.resolveModelDir('sensevoice')).toBe(oldDirectory);
  expect(await f.store.verifyModel('sensevoice')).toBe(true);
  expect((await f.packs.list())[0]).toMatchObject({
    downloaded: true,
    operation: { phase: 'failed' },
  });
});
