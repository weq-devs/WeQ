// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { c as archive } from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnhancementEngineStore } from '../src/main/enhancements/engine_store';
import {
  enhancementEngineCompatibility,
  parseEnhancementEngineManifest,
  type EnhancementEngineManifest,
} from '../src/shared/enhancement_manifest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weq-enhancement-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(join(source, 'node_modules/runtime'), { recursive: true });
  await writeFile(join(source, 'node_modules/runtime/a.js'), 'fixture engine');
  const path = join(root, 'engine.tar.gz');
  await archive({ cwd: source, file: path, gzip: true, portable: true }, [
    'node_modules/runtime/a.js',
  ]);
  const bytes = await readFile(path);
  const manifest: EnhancementEngineManifest = {
    schemaVersion: 1,
    target: 'darwin-arm64',
    engines: [
      {
        kind: 'onnx',
        id: 'onnx-fixture',
        compatibility: enhancementEngineCompatibility('onnx'),
        target: 'darwin-arm64',
        url: 'https://example.invalid/engine.tar.gz',
        downloadBytes: bytes.length,
        installedBytes: 14,
        sha256: sha(bytes),
        files: [
          { path: 'node_modules/runtime/a.js', size: 14, sha256: sha('fixture engine') },
          {
            path: 'node_modules/runtime/b.js',
            size: 14,
            sha256: sha('fixture engine'),
            link: 'node_modules/runtime/a.js',
          },
        ],
      },
    ],
  };
  const fetcher = vi.fn(
    async () =>
      new Response(bytes, {
        headers: { 'content-length': String(bytes.length), etag: '"fixture-v1"' },
      }),
  );
  const probe = vi.fn(async () => {});
  const store = new EnhancementEngineStore(root, manifest, {
    target: manifest.target,
    fetcher,
    probe,
  });
  return { root, source, bytes, manifest, fetcher, probe, store };
}

describe('增强引擎分发与就绪状态', () => {
  it('去重并发请求，校验后实际加载，动态库别名只占一份空间且重启不重下', async () => {
    const f = await fixture();
    const paths = await Promise.all([f.store.ensure('onnx'), f.store.ensure('onnx')]);
    expect(paths[0]).toBe(paths[1]);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.probe).toHaveBeenCalledTimes(1);
    const a = await stat(join(paths[0]!, 'node_modules/runtime/a.js'));
    const b = await stat(join(paths[0]!, 'node_modules/runtime/b.js'));
    expect(a.ino).toBe(b.ino);
    const restarted = new EnhancementEngineStore(f.root, f.manifest, {
      target: f.manifest.target,
      fetcher: f.fetcher,
      probe: f.probe,
    });
    expect(restarted.state('onnx')).toMatchObject({
      ready: true,
      downloadBytes: 0,
      installedBytes: 14,
    });
    await restarted.ensure('onnx');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.probe).toHaveBeenCalledTimes(2);
  });

  it('下载哈希错误与原生加载失败都不能写入就绪标记；重试可以恢复', async () => {
    const f = await fixture();
    f.manifest.engines[0]!.sha256 = '0'.repeat(64);
    await expect(f.store.ensure('onnx')).rejects.toThrow('哈希');
    expect(f.store.state('onnx').ready).toBe(false);
    expect(f.probe).not.toHaveBeenCalled();
    f.manifest.engines[0]!.sha256 = sha(f.bytes);
    f.probe.mockRejectedValueOnce(new Error('native load failed'));
    await expect(f.store.ensure('onnx')).rejects.toThrow('native load failed');
    expect(f.store.state('onnx').ready).toBe(false);
    await expect(f.store.ensure('onnx')).resolves.toContain('onnx-fixture');
    expect(await readdir(f.store.root)).toEqual(['onnx-fixture']);
  });

  it('更新加载失败保留旧兼容引擎，不把下载完成当作更新完成', async () => {
    const f = await fixture();
    const old = await f.store.ensure('onnx');
    const next = structuredClone(f.manifest);
    next.engines[0]!.id = 'onnx-next';
    const probe = vi.fn(async () => {
      throw new Error('incompatible');
    });
    const upgraded = new EnhancementEngineStore(f.root, next, {
      target: next.target,
      fetcher: f.fetcher,
      probe,
    });
    expect(upgraded.state('onnx').updateAvailable).toBe(true);
    await expect(upgraded.ensure('onnx')).rejects.toThrow('incompatible');
    expect(upgraded.directory('onnx')).toBe(old);
    expect(await readFile(join(old, 'node_modules/runtime/a.js'), 'utf8')).toBe('fixture engine');
  });

  it('更新保留的旧引擎计入删除量，清理不按前缀删除未知目录', async () => {
    const f = await fixture();
    await f.store.ensure('onnx');
    const next = structuredClone(f.manifest);
    next.engines[0]!.id = 'onnx-next';
    const upgraded = new EnhancementEngineStore(f.root, next, {
      target: next.target,
      fetcher: f.fetcher,
      probe: f.probe,
    });
    await upgraded.ensure('onnx');
    expect(upgraded.state('onnx').installedBytes).toBe(28);
    await mkdir(join(upgraded.root, 'onnx-unknown'));
    await writeFile(join(upgraded.root, 'onnx-unknown/original.txt'), 'preserved');
    await upgraded.remove('onnx');
    expect(await readdir(upgraded.root)).toEqual(['onnx-unknown']);
  });

  it('拒绝清单路径穿越、伪造链接和错误平台，不执行任何下载', async () => {
    const f = await fixture();
    expect(() => new EnhancementEngineStore(f.root, f.manifest, { target: 'linux-x64' })).toThrow(
      '平台',
    );
    for (const path of [
      '../outside',
      '/absolute',
      'C:/outside',
      'node_modules/../outside',
      'node_modules/a\\b',
    ]) {
      const bad = structuredClone(f.manifest);
      bad.engines[0]!.files[0]!.path = path;
      expect(() => parseEnhancementEngineManifest(bad)).toThrow();
    }
    const invalidLink = structuredClone(f.manifest);
    invalidLink.engines[0]!.files[1]!.link = '../outside';
    expect(() => parseEnhancementEngineManifest(invalidLink)).toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('拒绝归档内的符号链接，原生探测不会读取包外代码', async () => {
    const f = await fixture();
    await rm(join(f.source, 'node_modules/runtime/a.js'));
    await symlink('/outside', join(f.source, 'node_modules/runtime/a.js'));
    const path = join(f.root, 'linked.tar.gz');
    await archive({ cwd: f.source, file: path, gzip: true }, ['node_modules/runtime/a.js']);
    const bytes = await readFile(path);
    f.manifest.engines[0]!.downloadBytes = bytes.length;
    f.manifest.engines[0]!.sha256 = sha(bytes);
    f.fetcher.mockImplementation(
      async () =>
        new Response(bytes, {
          headers: { 'content-length': String(bytes.length), etag: '"linked"' },
        }),
    );
    await expect(f.store.ensure('onnx')).rejects.toThrow('归档条目');
    expect(f.probe).not.toHaveBeenCalled();
  });
});
