// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import {
  readRuntimeSource,
  runtimeManifest,
  completeDeployLock,
  validateRuntimeMetadata,
  pnpmInvocation,
} from '../../web/scripts/runtime-deps.mjs';
const root = resolve(__dirname, '../../..');
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('Web 分发依赖从冻结工作区离线部署，构建后不得重新 npm install', () => {
  const source = readFileSync(resolve(root, 'apps/web/scripts/install-runtime-deps.mjs'), 'utf8');
  expect(source).toContain('--frozen-lockfile');
  expect(source).toContain('--offline');
  expect(source).toContain('deploy');
  expect(source).not.toMatch(/npm\(\[\s*['"]install/);
});

it('真实离线部署、原生/WASM 探针与冻结修复安装可重复，不修改根锁文件', () => {
  const source = readRuntimeSource(root);
  const directory = mkdtempSync(join(tmpdir(), 'weq-runtime-lock-'));
  temporary.push(directory);
  const version = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8')).version;
  writeFileSync(join(directory, 'package.json'), JSON.stringify(runtimeManifest(source, version)));
  const before = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const stateBefore = readFileSync(
    join(root, 'node_modules/.pnpm-workspace-state-v1.json'),
    'utf8',
  );
  const install = () =>
    spawnSync(process.execPath, [join(root, 'apps/web/scripts/install-runtime-deps.mjs')], {
      cwd: root,
      env: { ...process.env, WEQ_WEB_DIST: directory },
      encoding: 'utf8',
      timeout: 60_000,
    });
  const first = install();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  const metadata = validateRuntimeMetadata(directory);
  expect(metadata.sourceLockSha256).toBe(source.sourceLockSha256);
  const lock = readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8');
  const pnpm = pnpmInvocation(process.env.npm_execpath);
  const repair = spawnSync(
    pnpm.command,
    [
      ...pnpm.prefix,
      '--dir',
      directory,
      'install',
      '--prod',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--ignore-workspace',
      '--node-linker=hoisted',
      '--dry-run',
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(repair.status, repair.stdout + repair.stderr).toBe(0);
  const second = install();
  expect(second.status, second.stdout + second.stderr).toBe(0);
  expect(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8')).toBe(lock);
  expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(before);
  expect(readFileSync(join(root, 'node_modules/.pnpm-workspace-state-v1.json'), 'utf8')).toBe(
    stateBefore,
  );
  expect(existsSync(join(directory, 'node_modules/.modules.yaml'))).toBe(false);
  expect(() => validateRuntimeMetadata(directory, { sourceLockSha256: 'changed' })).toThrow();
  writeFileSync(join(directory, 'pnpm-lock.yaml'), lock + '\n# changed');
  expect(() => validateRuntimeMetadata(directory)).toThrow();
}, 60_000);

it('转移锁树必须保持依赖版本与完整性，不接受新增解析结果', () => {
  const source = readRuntimeSource(root);
  const snapshot = structuredClone(source.project);
  snapshot.importers = { '.': structuredClone(source.project.importers['packages/web-runtime']) };
  const serialized = source.codec.dump(snapshot);
  expect(completeDeployLock(source, serialized)).toContain('packageManagerDependencies:');
  snapshot.importers['.'].dependencies.ws.version = '999.0.0';
  expect(() => completeDeployLock(source, source.codec.dump(snapshot))).toThrow();
  snapshot.importers['.'] = structuredClone(source.project.importers['packages/web-runtime']);
  const first = Object.keys(snapshot.packages)[0]!;
  snapshot.packages[first].resolution.integrity = 'sha512-changed';
  expect(() => completeDeployLock(source, source.codec.dump(snapshot))).toThrow();
});

it('包管理器参数使用原生 argv，带空格的 Windows 路径不会进入 shell', () => {
  expect(pnpmInvocation('C:\\Program Files\\pnpm\\pnpm.cjs')).toEqual({
    command: process.execPath,
    prefix: ['C:\\Program Files\\pnpm\\pnpm.cjs'],
  });
  expect(pnpmInvocation('C:\\Program Files\\pnpm\\pnpm.exe')).toEqual({
    command: 'C:\\Program Files\\pnpm\\pnpm.exe',
    prefix: [],
  });
  expect(() => pnpmInvocation(undefined)).toThrow();
});
