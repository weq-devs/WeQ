import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { RESVG_BINDINGS } from './platform.mjs';

export const RUNTIME_MODULES = ['@resvg/resvg-js', 'quickjs-emscripten', 'sharp', 'ws'];
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const digest = (value) => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function yaml(root) {
  // 复用已冻结的构建依赖，不为读取 pnpm 多文档锁文件引入另一套解析器。
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const builder = createRequire(require.resolve('electron-builder/package.json'));
  const appBuilder = createRequire(builder.resolve('app-builder-lib/package.json'));
  return appBuilder('js-yaml');
}

export function readRuntimeSource(root) {
  const manifest = json(join(root, 'packages/web-runtime/package.json'));
  const packageManager = json(join(root, 'package.json')).packageManager;
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) throw new Error('Web 分发需要精确的 pnpm 版本');
  if (manifest.packageManager !== packageManager)
    throw new Error('Web 运行包必须沿用根包管理器版本');
  if (!same(Object.keys(manifest.dependencies).sort(), [...RUNTIME_MODULES].sort()))
    throw new Error('Web 外置模块清单不匹配');
  const sourceLock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const codec = yaml(root);
  const documents = codec.loadAll(sourceLock);
  const project = documents.find((doc) => doc?.importers?.['packages/web-runtime']);
  const manager = documents.find((doc) => doc?.importers?.['.']?.packageManagerDependencies);
  if (!project || !manager) throw new Error('缺少 Web 运行包或包管理器冻结记录');
  const importer = project.importers['packages/web-runtime'];
  for (const name of RUNTIME_MODULES) {
    if (importer.dependencies?.[name]?.specifier !== manifest.dependencies[name])
      throw new Error(`运行依赖 ${name} 与锁文件不一致`);
    if (
      importer.dependencies[name].version !==
      project.importers['apps/desktop']?.dependencies?.[name]?.version
    )
      throw new Error(`运行依赖 ${name} 与桌面冻结版本不一致`);
  }
  return {
    manifest,
    packageManager,
    project,
    manager,
    codec,
    sourceLockSha256: digest(sourceLock),
  };
}

export function runtimeManifest(source, version) {
  return {
    name: 'weq-web',
    version,
    private: true,
    type: 'module',
    packageManager: source.packageManager,
    dependencies: source.manifest.dependencies,
  };
}

export function assertRuntimeManifest(actual, expected) {
  if (!same(actual, expected)) throw new Error('Web 构建清单已过期，请重新 build');
}

export function pnpmInvocation(execPath) {
  if (!execPath || /\.cmd$/i.test(execPath))
    throw new Error('请通过 pnpm --filter @weq/web deps 调用');
  return /\.(?:cjs|mjs|js)$/i.test(execPath)
    ? { command: process.execPath, prefix: [execPath] }
    : { command: execPath, prefix: [] };
}

/** deploy 只生成项目文档；pnpm 12 的包管理器文档也要保留，修复安装才能 frozen。 */
export function completeDeployLock(source, text) {
  const project = source.codec.loadAll(text).find((doc) => doc?.importers?.['.']?.dependencies);
  if (
    !project ||
    !same(
      project.importers['.'].dependencies,
      source.project.importers['packages/web-runtime'].dependencies,
    )
  )
    throw new Error('部署根依赖偏离冻结清单');
  for (const [name, pkg] of Object.entries(project.packages ?? {})) {
    if (!same(pkg.resolution, source.project.packages?.[name]?.resolution))
      throw new Error(`部署包 ${name} 的完整性偏离根锁文件`);
  }
  for (const [name, snapshot] of Object.entries(project.snapshots ?? {})) {
    const original = source.project.snapshots?.[name];
    if (!original) throw new Error(`部署包含未冻结的依赖 ${name}`);
    for (const key of ['dependencies', 'optionalDependencies', 'transitivePeerDependencies'])
      if (!same(snapshot[key] ?? {}, original[key] ?? {}))
        throw new Error(`部署依赖边 ${name} 偏离根锁文件`);
  }
  const options = { noRefs: true, lineWidth: 120 };
  return (
    '---\n' +
    source.codec.dump(source.manager, options) +
    '\n---\n' +
    source.codec.dump(project, options)
  );
}

export function validateRuntimeMetadata(dist, source = undefined) {
  const metadata = json(join(dist, 'runtime-deps.json'));
  const lock = readFileSync(join(dist, 'pnpm-lock.yaml'));
  const manifest = json(join(dist, 'package.json'));
  if (
    metadata.schemaVersion !== 1 ||
    metadata.lockSha256 !== digest(lock) ||
    !same(metadata.dependencies, manifest.dependencies) ||
    metadata.packageManager !== manifest.packageManager
  )
    throw new Error('Web 运行依赖清单或锁文件不完整，请重新构建');
  if (source && metadata.sourceLockSha256 !== source.sourceLockSha256)
    throw new Error('Web 运行依赖来自旧锁文件，请重新 deps');
  return metadata;
}

export async function probeRuntime(dist, target) {
  const require = createRequire(join(dist, 'package.json'));
  const boundary = realpathSync(join(dist, 'node_modules'));
  for (const name of [...RUNTIME_MODULES, RESVG_BINDINGS[target]]) {
    const path = realpathSync(require.resolve(name));
    const rel = relative(boundary, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\'))
      throw new Error(`运行依赖 ${name} 越出分发目录`);
  }
  const png = await require('sharp')({
    create: { width: 1, height: 1, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  if (!png.length) throw new Error('sharp 原生探针失败');
  const svg = new (require('@resvg/resvg-js').Resvg)(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    { font: { loadSystemFonts: false } },
  )
    .render()
    .asPng();
  if (!svg.length) throw new Error('resvg 原生探针失败');
  const quickjs = await require('quickjs-emscripten').getQuickJS();
  const context = quickjs.newContext();
  try {
    const result = context.evalCode('1 + 2');
    try {
      if (result.error || context.dump(result.value) !== 3)
        throw new Error('QuickJS WASM 探针失败');
    } finally {
      result.error?.dispose();
      result.value?.dispose();
    }
  } finally {
    context.dispose();
  }
}
