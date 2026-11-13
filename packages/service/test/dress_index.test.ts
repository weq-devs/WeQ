import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NtHelperBinding } from '@weq/native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DressIndexStore,
  parseDressIndexManifest,
  type DressIndexManifest,
} from '../src/account/dress_index';

const bytes = Buffer.concat([Buffer.from('NTDR\x01'), Buffer.alloc(32, 7)]);
const digest = createHash('sha256').update(bytes).digest('hex');
const manifest: DressIndexManifest = {
  schemaVersion: 1,
  tag: 'dress-0123456',
  nativeCommit: '0123456789012345678901234567890123456789',
  format: 'ntdr-v1',
  baseUrl: 'https://example.invalid/releases/download/dress-0123456',
  parts: Object.fromEntries(
    ['bubble', 'font', 'widget'].map((kind) => [
      kind,
      { asset: `dress-${kind}.dat`, sha256: digest, size: bytes.length },
    ]),
  ) as DressIndexManifest['parts'],
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weq-dress-index-'));
  directories.push(root);
  const download = vi.fn(async (_url: string, destination: string) => {
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, bytes);
    return {
      ok: true as const,
      bytes: bytes.length,
      sha256: digest,
      contentType: 'application/octet-stream',
    };
  });
  const store = new DressIndexStore(join(root, 'cache'), manifest, { download });
  return { root, store, download };
}

describe('装扮索引独立按需分发', () => {
  it('并发请求只下载所需类别，完成后重启离线复用并检查哈希', async () => {
    const { store, download, root } = await fixture();
    expect(await Promise.all(Array.from({ length: 10 }, () => store.ensure('bubble')))).toEqual(
      Array(10).fill(true),
    );
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0].endsWith('/dress-bubble.dat')).toBe(true);
    expect(await readdir(store.directory)).toEqual(['bubble.dat']);
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    const restarted = new DressIndexStore(join(root, 'cache'), manifest, { download: offline });
    expect(await restarted.ensure('bubble')).toBe(true);
    expect(offline).not.toHaveBeenCalled();
  });

  it('坏哈希不发布；失败冷却抑制重复请求，显式重试可以立即恢复', async () => {
    const { root } = await fixture();
    let bad = true;
    const download = vi.fn(async (_url: string, target: string) => {
      await writeFile(target, bad ? Buffer.from('bad') : bytes);
      return {
        ok: true as const,
        bytes: bytes.length,
        sha256: digest,
        contentType: 'application/octet-stream',
      };
    });
    const store = new DressIndexStore(join(root, 'bad'), manifest, { download });
    expect(await store.ensure('font')).toBe(false);
    expect(await readdir(store.directory)).toEqual([]);
    expect(await store.ensure('font')).toBe(false);
    expect(download).toHaveBeenCalledTimes(1);
    bad = false;
    expect(await store.ensure('font', true)).toBe(true);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('迁移经过校验的旧索引且保留旧文件，不重新下载', async () => {
    const { root, download } = await fixture();
    const legacy = join(root, 'legacy');
    await mkdir(legacy);
    await writeFile(join(legacy, 'widget.dat'), bytes);
    const store = new DressIndexStore(join(root, 'migration'), manifest, {
      download,
      legacyDirectory: legacy,
    });
    expect(await store.ensure('widget')).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(await readFile(join(legacy, 'widget.dat'))).toEqual(bytes);
    expect(await readFile(join(store.directory, 'widget.dat'))).toEqual(bytes);
  });

  it('显式删除后重启不从旧资源自动恢复，重新准备仍可复用旧完整索引', async () => {
    const { root, download } = await fixture();
    const legacy = join(root, 'legacy-removed');
    await mkdir(legacy);
    await writeFile(join(legacy, 'widget.dat'), bytes);
    const store = new DressIndexStore(join(root, 'removed'), manifest, {
      download,
      legacyDirectory: legacy,
    });
    expect(await store.ensure('widget')).toBe(true);
    await store.remove();
    const restarted = new DressIndexStore(join(root, 'removed'), manifest, {
      download,
      legacyDirectory: legacy,
    });
    expect((await restarted.inspect()).every((state) => state.status !== 'ready')).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(await restarted.ensure('widget', true)).toBe(true);
    expect(download).not.toHaveBeenCalled();
  });

  it('已有 legacy native 查询命中时不下载；新索引查询临时目录不污染环境', async () => {
    const { store, download } = await fixture();
    const previous = process.env.NT_HELPER_DRESS_DIR;
    process.env.NT_HELPER_DRESS_DIR = '/custom/legacy';
    const query = vi.fn(() => ({ url: 'https://example.invalid/item.zip', size: 10 }));
    const native = { queryDressResourceUrl: query } as unknown as NtHelperBinding;
    try {
      expect(await store.resolve(native, 'bubble', '1', 'static.zip')).toMatchObject({ size: 10 });
      expect(download).not.toHaveBeenCalled();
      query.mockImplementation(() =>
        process.env.NT_HELPER_DRESS_DIR === store.directory
          ? { url: 'https://example.invalid/downloaded.zip', size: 11 }
          : (null as unknown as ReturnType<typeof query>),
      );
      expect(await store.resolve(native, 'bubble', '2', 'static.zip')).toBeNull();
      expect(download).not.toHaveBeenCalled();
      expect(await store.ensure('bubble')).toBe(true);
      expect(await store.resolve(native, 'bubble', '2', 'static.zip')).toMatchObject({ size: 11 });
      expect(process.env.NT_HELPER_DRESS_DIR).toBe('/custom/legacy');
    } finally {
      if (previous === undefined) delete process.env.NT_HELPER_DRESS_DIR;
      else process.env.NT_HELPER_DRESS_DIR = previous;
    }
  });

  it('普通在线或离线浏览均不隐式下载整类索引，显式准备后仍可查询', async () => {
    const { store, download } = await fixture();
    const native = { queryDressResourceUrl: vi.fn(() => null) } as unknown as NtHelperBinding;
    expect(await store.resolve(native, 'font', '1', 'font.zip')).toBeNull();
    expect(await store.resolve(native, 'widget', '2', 'main.zip', { background: true })).toBeNull();
    await store.inspect();
    expect(download).not.toHaveBeenCalled();
    expect(await store.ensure('font')).toBe(true);
    await store.remove();
    expect(store.snapshot().every((state) => state.status === 'idle')).toBe(true);
  });

  it('校验清单格式、类别资产名、体积和源 native 身份', () => {
    expect(parseDressIndexManifest(manifest)).toEqual(manifest);
    for (const invalid of [
      { ...manifest, format: 'ntdr-v2' },
      { ...manifest, nativeCommit: 'main' },
      { ...manifest, baseUrl: 'file:///tmp/assets' },
      {
        ...manifest,
        parts: { ...manifest.parts, font: { ...manifest.parts.font, asset: '../font.dat' } },
      },
      { ...manifest, parts: { ...manifest.parts, font: { ...manifest.parts.font, size: 0 } } },
    ])
      expect(() => parseDressIndexManifest(invalid)).toThrow();
  });
});
