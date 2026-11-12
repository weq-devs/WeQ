import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { qqSyncArtifacts, qqSyncFiles, verifyQqSync } from '../qq-sync.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qq-sync-assets-'));
  roots.push(root);
  const buildId = '1234567890abcdef';
  const files: Record<string, { asset: string; sha256: string; size: number }> = {};
  for (const [path, asset] of Object.entries({
    'runtime.mjs': 'qq-sync-runtime-win32-x64.mjs',
    'generated/windows/QqSync/current.json': 'qq-sync-current.json',
    [`generated/windows/QqSync/${buildId}/WeQ.QqSyncHost.exe`]: 'WeQ.QqSyncHost.exe',
    [`generated/windows/QqSync/${buildId}/WeQ.QqSyncProbe.dll`]: 'WeQ.QqSyncProbe.dll',
  })) {
    const bytes = Buffer.from('synthetic');
    files[path] = {
      asset,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    writeFileSync(join(root, asset), bytes);
  }
  const bundle = { protocol: 1, buildId, files };
  const bytes = Buffer.from(JSON.stringify(bundle));
  writeFileSync(join(root, 'bundle.json'), bytes);
  writeFileSync(join(root, 'qq-sync-win32-x64.json'), bytes);
  return {
    root,
    bundle,
    metadata: {
      ...bundle,
      asset: 'qq-sync-win32-x64.json',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

it('旧清单保留兼容性，Windows 发布必须具备配套组件，其他平台不加载', () => {
  expect(qqSyncArtifacts({}, 'win32-x64')).toEqual([]);
  expect(() => qqSyncArtifacts({}, 'win32-x64', { required: true })).toThrow(/尚未发布/);
  expect(qqSyncArtifacts({}, 'linux-x64', { required: true })).toEqual([]);
});

it('只接受固定运行文件并校验内容，拒绝篡改、源码和越界路径', () => {
  const { root, bundle } = fixture();
  expect(verifyQqSync(root)).toBe(join(root, 'runtime.mjs'));
  for (const path of ['../outside', 'src/qq_sync_bridge.mjs']) {
    expect(() =>
      qqSyncFiles({ ...bundle, files: { ...bundle.files, [path]: bundle.files['runtime.mjs'] } }),
    ).toThrow();
  }
  writeFileSync(join(root, 'runtime.mjs'), 'tampered');
  expect(() => verifyQqSync(root)).toThrow(/内容不匹配/);
});

it('native:fetch 从同一发布清单安装全部组件，可离线校验并拒绝损坏资产', () => {
  const { root, metadata } = fixture();
  const target = join(root, 'installed');
  const native = Buffer.from('synthetic-native');
  writeFileSync(join(root, 'nt_helper-win32-x64.node'), native);
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      tag: 'nt-helper-fixture',
      platforms: {
        'win32-x64': {
          asset: 'nt_helper-win32-x64.node',
          sha256: createHash('sha256').update(native).digest('hex'),
          size: native.length,
        },
      },
      qqSync: { 'win32-x64': metadata },
    }),
  );
  const script = fileURLToPath(new URL('../../../scripts/fetch-native.mjs', import.meta.url));
  const args = [
    script,
    '--from-dir',
    root,
    '--root',
    target,
    '--platform',
    'win32-x64',
    '--no-dress',
    '--no-authorization',
    '--require-qq-sync',
    '--quiet',
  ];
  const fetched = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  expect(fetched.status, fetched.stderr).toBe(0);
  expect(verifyQqSync(join(target, 'native/qq-sync'))).toBe(
    join(target, 'native/qq-sync/runtime.mjs'),
  );
  const original = readFileSync(join(target, 'native/qq-sync/runtime.mjs'));
  writeFileSync(join(root, 'qq-sync-runtime-win32-x64.mjs'), 'tampered');
  expect(
    spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true }).status,
  ).not.toBe(0);
  expect(readFileSync(join(target, 'native/qq-sync/runtime.mjs'))).toEqual(original);
});
