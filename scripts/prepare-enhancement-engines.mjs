import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const require = createRequire(join(desktop, 'package.json'));
const { c: archive } = require('tar');
const { ENHANCEMENT_ENGINE_RECIPES, enhancementEngineCompatibility } = await tsImport(
  '../apps/desktop/src/shared/enhancement_manifest.ts',
  import.meta.url,
);

export async function hashEnhancementFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function packageDirectory(name) {
  const resolver =
    name.startsWith('sherpa-onnx-') && name !== 'sherpa-onnx-node'
      ? createRequire(require.resolve('sherpa-onnx-node/package.json'))
      : require;
  let entry;
  try {
    entry = resolver.resolve(`${name}/package.json`);
  } catch {
    entry = resolver.resolve(name);
  }
  let directory = dirname(await realpath(entry));
  while (directory !== dirname(directory)) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === name) return { directory, pkg };
    } catch {
      /* 入口不一定与清单同层。 */
    }
    directory = dirname(directory);
  }
  throw new Error(`找不到增强引擎依赖：${name}`);
}

async function collect(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!['node_modules', 'test', 'tests', 'script', 'src'].includes(entry.name))
        files.push(...(await collect(directory, path)));
    } else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
  }
  return files.sort();
}

/** 从构建机现有依赖准备目标引擎，不安装依赖、不下载模型、不改应用 manifest。 */
export async function prepareEnhancementEngines(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== process.platform || arch !== process.arch)
    throw new Error('增强引擎必须在目标平台及架构上准备并验证');
  const target = `${platform}-${arch}`;
  const version = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).version;
  const tag = options.tag ?? `v${version}`;
  if (!/^v[0-9][a-zA-Z0-9.+-]*$/.test(tag)) throw new Error('增强引擎发布标签无效');
  const output = options.output ?? join(desktop, '.artifacts/enhancements', target);
  await mkdir(output, { recursive: true });
  const engines = [];
  for (const [kind, recipe] of Object.entries(ENHANCEMENT_ENGINE_RECIPES)) {
    if (!recipe.targets.includes(target)) continue;
    const stage = join(output, `${kind}.staging`);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    try {
      const packages = { ...recipe.packages };
      if (kind === 'sherpa')
        packages[`sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`] =
          packages['sherpa-onnx-node'];
      const files = [];
      for (const [name, expectedVersion] of Object.entries(packages)) {
        const { directory, pkg } = await packageDirectory(name);
        if (pkg.version !== expectedVersion)
          throw new Error(`${name} 版本不匹配：${pkg.version} / ${expectedVersion}`);
        for (const path of await collect(directory)) {
          if (/\.(map|ts|mts|cts)$/.test(path)) continue;
          if (path.startsWith('bin/') && !path.startsWith(`bin/napi-v6/${platform}/${arch}/`))
            continue;
          if (
            !/\.(js|mjs|cjs|json|wasm|node|dylib|dll)$|\.so(?:\.\d+)*$|(?:^|\/)(?:LICENSE|NOTICE)(?:\..*)?$/i.test(
              path,
            )
          )
            continue;
          const destination = join(stage, 'node_modules', name, path);
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(join(directory, path), destination);
          files.push({
            path: relative(stage, destination).replaceAll('\\', '/'),
            size: (await stat(destination)).size,
            sha256: await hashEnhancementFile(destination),
          });
        }
      }
      // macOS 的 ONNX 兼容别名可能是整份副本；归档只存一份，安装时恢复为硬链接。
      const libraries = new Map();
      for (const file of files) {
        if (!file.path.endsWith('.dylib')) continue;
        const key = `${dirname(file.path)}:${file.sha256}`;
        const original = libraries.get(key);
        if (original) {
          file.link = original;
          await rm(join(stage, file.path));
        } else libraries.set(key, file.path);
      }
      if (platform === 'darwin') {
        for (const file of files.filter(
          (file) => !file.link && /\.(node|dylib)$/.test(file.path),
        )) {
          const path = join(stage, file.path);
          execFileSync('codesign', ['--force', '--sign', '-', path], { stdio: 'pipe' });
          execFileSync('codesign', ['--verify', '--strict', path], { stdio: 'pipe' });
          file.size = (await stat(path)).size;
          file.sha256 = await hashEnhancementFile(path);
        }
        for (const file of files.filter((file) => file.link)) {
          const original = files.find((candidate) => candidate.path === file.link);
          file.size = original.size;
          file.sha256 = original.sha256;
        }
      }
      files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
      const compatibility = enhancementEngineCompatibility(kind);
      const identity = createHash('sha256')
        .update(JSON.stringify({ kind, compatibility, target, files }))
        .digest('hex')
        .slice(0, 16);
      const id = `${kind}-${compatibility}-${target}-${identity}`;
      const asset = `${id}.tar.gz`;
      await archive(
        { cwd: stage, file: join(output, asset), gzip: true, portable: true, noMtime: true },
        files.filter((file) => !file.link).map((file) => file.path),
      );
      engines.push({
        kind,
        id,
        compatibility,
        target,
        url: `https://github.com/weq-devs/WeQ/releases/download/${tag}/${asset}`,
        sha256: await hashEnhancementFile(join(output, asset)),
        downloadBytes: (await stat(join(output, asset))).size,
        installedBytes: files.reduce((sum, file) => sum + (file.link ? 0 : file.size), 0),
        files,
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  const manifest = { schemaVersion: 1, target, engines };
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `[enhancements] ${target}: ${engines.map((engine) => `${engine.kind} ${(engine.downloadBytes / 1048576).toFixed(2)} MiB → ${(engine.installedBytes / 1048576).toFixed(2)} MiB`).join(', ')}`,
  );
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareEnhancementEngines();
