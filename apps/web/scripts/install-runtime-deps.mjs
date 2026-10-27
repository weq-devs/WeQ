/** 从工作区冻结锁树离线部署外置模块，不再 npm 二次解析。 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTarget } from './platform.mjs';
import {
  readRuntimeSource,
  runtimeManifest,
  assertRuntimeManifest,
  pnpmInvocation,
  completeDeployLock,
  digest,
} from './runtime-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const dist = resolve(process.env.WEQ_WEB_DIST ?? join(here, '../dist'));
if (!existsSync(join(dist, 'package.json'))) throw new Error('请先构建 Web 分发目录');
const source = readRuntimeSource(root);
const version = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8')).version;
const manifest = runtimeManifest(source, version);
assertRuntimeManifest(JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8')), manifest);
const target = currentTarget();
const stage = join(dirname(dist), `.weq-runtime-${randomUUID()}`);
const old = join(dirname(dist), `.weq-runtime-old-${randomUUID()}`);
let movedOld = false;
let installed = false;
const previous = Object.fromEntries(
  ['pnpm-lock.yaml', 'runtime-deps.json'].map((name) => [
    name,
    existsSync(join(dist, name)) ? readFileSync(join(dist, name)) : null,
  ]),
);
try {
  const pnpm = pnpmInvocation(process.env.npm_execpath);
  const result = spawnSync(
    pnpm.command,
    [
      ...pnpm.prefix,
      '--filter',
      '@weq/web-runtime',
      'deploy',
      '--prod',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--node-linker=hoisted',
      stage,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('冻结运行依赖部署失败，未更新 dist');
  const lock = completeDeployLock(source, readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8'));
  writeFileSync(join(stage, 'pnpm-lock.yaml'), lock);
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const repair = spawnSync(
    pnpm.command,
    [
      ...pnpm.prefix,
      '--dir',
      stage,
      'install',
      '--prod',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--ignore-workspace',
      '--node-linker=hoisted',
      '--dry-run',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (repair.status !== 0) throw new Error('冻结修复安装验证失败，未更新 dist');
  const probe = spawnSync(process.execPath, [join(here, 'probe-runtime.mjs'), stage, target], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH: '' },
  });
  if (probe.status !== 0) throw new Error('运行依赖原生/WASM 探针失败，未更新 dist');
  // 删除本轮生成、包含本机绝对路径的安装状态，不把它们交付给用户。
  for (const file of ['.modules.yaml', '.pnpm-workspace-state-v1.json'])
    rmSync(join(stage, 'node_modules', file), { force: true });
  mkdirSync(dist, { recursive: true });
  if (existsSync(join(dist, 'node_modules'))) {
    renameSync(join(dist, 'node_modules'), old);
    movedOld = true;
  }
  try {
    renameSync(join(stage, 'node_modules'), join(dist, 'node_modules'));
  } catch (error) {
    if (movedOld) {
      renameSync(old, join(dist, 'node_modules'));
      movedOld = false;
    }
    throw error;
  }
  installed = true;
  writeFileSync(join(dist, 'pnpm-lock.yaml'), lock);
  writeFileSync(
    join(dist, 'runtime-deps.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        target,
        packageManager: source.packageManager,
        sourceLockSha256: source.sourceLockSha256,
        lockSha256: digest(lock),
        dependencies: manifest.dependencies,
      },
      null,
      2,
    )}\n`,
  );
  installed = false;
  if (movedOld) {
    try {
      rmSync(old, { recursive: true, force: true });
    } catch {
      console.warn('旧运行依赖暂存清理失败：', old);
    }
    movedOld = false;
  }
  console.log(`冻结运行依赖已部署：${target}`);
} catch (error) {
  if (installed) {
    rmSync(join(dist, 'node_modules'), { recursive: true, force: true });
    if (movedOld) {
      renameSync(old, join(dist, 'node_modules'));
      movedOld = false;
    }
    for (const [name, data] of Object.entries(previous)) {
      if (data === null) rmSync(join(dist, name), { force: true });
      else writeFileSync(join(dist, name), data);
    }
  }
  throw error;
} finally {
  rmSync(stage, { recursive: true, force: true });
}
