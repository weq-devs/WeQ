import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { hashFile, readCache, writeJson } from './dev-prepare.mjs';
import { startupLog } from './dev-process.mjs';

const inputs = [
  'apps/desktop/src/renderer',
  'apps/desktop/src/shared',
  'apps/desktop/package.json',
  'apps/desktop/electron.vite.config.ts',
  'apps/desktop/tsconfig*.json',
  'apps/web/vite.config.ts',
  'apps/web/scripts',
  'apps/web/package.json',
  'apps/web/tsconfig*.json',
  ':(glob)packages/*/src/**',
  ':(glob)packages/*/package.json',
  ':(glob)packages/*/tsconfig*.json',
  'resources',
  'patches',
  'scripts/dev-web.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'postcss.config.*',
  'tailwind.config.*',
];

async function fingerprint(root, names, previous = {}) {
  const files = {};
  for (let offset = 0; offset < names.length; offset += 32) {
    await Promise.all(
      names.slice(offset, offset + 32).map(async (name) => {
        try {
          const info = await stat(resolve(root, name), { bigint: true });
          if (!info.isFile()) throw new Error(`构建输入不是文件：${name}`);
          const stamp = [String(info.size), String(info.mtimeNs), String(info.ctimeNs)].join(':');
          const cached = previous?.[name];
          const sha256 =
            cached?.stamp === stamp && /^[a-f0-9]{64}$/.test(cached.sha256)
              ? cached.sha256
              : info.size <= 524288n
                ? createHash('sha256')
                    .update(await readFile(resolve(root, name)))
                    .digest('hex')
                : await hashFile(resolve(root, name));
          files[name] = { stamp, sha256 };
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          files[name] = { stamp: null, sha256: null };
        }
      }),
    );
  }
  const digest = createHash('sha256');
  for (const name of names) digest.update(JSON.stringify([name, files[name].sha256]));
  return { digest: digest.digest('hex'), files };
}

async function sourceState(root, env, previous) {
  let listed;
  try {
    listed = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    return null;
  }
  const names = new Set(listed.split('\0').filter(Boolean));
  for (const directory of ['', 'apps/web', 'apps/desktop/src/renderer']) {
    for (const suffix of ['', '.local', '.production', '.production.local'])
      names.add(join(directory, `.env${suffix}`));
  }
  names.add('node_modules/.modules.yaml');
  names.add('node_modules/.pnpm/lock.yaml');
  const result = await fingerprint(root, [...names].sort(), previous?.files);
  const environment = Object.entries(env)
    .filter(([key]) => key.startsWith('VITE_'))
    .sort(([a], [b]) => a.localeCompare(b));
  result.digest = createHash('sha256')
    .update(result.digest)
    .update(
      JSON.stringify([
        'weq-dev-web-v1',
        process.version,
        process.platform,
        process.arch,
        env.NODE_OPTIONS ?? '',
        environment,
      ]),
    )
    .digest('hex');
  return result;
}

async function outputState(directory, previous) {
  const manifest = await readCache(join(directory, '.vite/manifest.json'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const entries = Object.values(manifest);
  if (
    !entries.some((entry) => entry?.isEntry) ||
    !(await fileExists(join(directory, 'index.html')))
  )
    return null;
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string') return null;
    for (const field of ['css', 'assets', 'imports', 'dynamicImports']) {
      if (
        entry[field] !== undefined &&
        (!Array.isArray(entry[field]) || entry[field].some((value) => typeof value !== 'string'))
      )
        return null;
    }
    if (
      [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])].some(
        (name) => !Object.hasOwn(manifest, name),
      )
    )
      return null;
    for (const name of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) {
      const path = resolve(directory, name);
      if (!path.startsWith(resolve(directory) + sep) || !(await fileExists(path))) return null;
    }
  }
  const names = [];
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else names.push(relative(directory, child));
    }
  };
  await visit(directory);
  return fingerprint(directory, names.sort(), previous?.files);
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function buildWeb(root, env) {
  const pnpm = env.npm_execpath;
  if (!pnpm) throw new Error('请通过 pnpm 运行桌面构建，以同时构建内置 Web 页面。');
  const args = ['--filter', '@weq/web', 'exec', 'vite', 'build'];
  const script = /\.[cm]?js$/.test(pnpm);
  execFileSync(script ? process.execPath : pnpm, script ? [pnpm, ...args] : args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32' && pnpm.endsWith('.cmd'),
  });
}

export async function prepareWebAssets(
  root,
  {
    env = process.env,
    cache = env.NODE_ENV_ELECTRON_VITE === 'development',
    build = buildWeb,
    log = startupLog,
    marker = join(root, '.weq-dev/web-build.json'),
  } = {},
) {
  const started = performance.now();
  const childEnv = { ...env, NODE_ENV: 'production', WEQ_DEV_WEB_CACHE: cache ? '1' : '0' };
  if (!cache) {
    await build(root, childEnv);
    return { cached: false };
  }
  const directory = resolve(env.WEQ_WEB_DIST ?? join(root, 'apps/web/dist'), 'public');
  const previous = await readCache(marker);
  const before = await sourceState(root, childEnv, previous?.inputs);
  if (
    before &&
    previous?.format === 1 &&
    previous.directory === directory &&
    previous.inputs?.digest === before.digest
  ) {
    const outputs = await outputState(directory, previous.outputs);
    if (outputs && outputs.digest === previous.outputs?.digest) {
      const durationMs = Math.round(performance.now() - started);
      log(`内置 Web 资源未变化，复用已有构建（校验 ${durationMs}ms）`, 'info', 'vite-web');
      return { cached: true, durationMs };
    }
  }
  await rm(marker, { force: true });
  await build(root, childEnv);
  if (before) {
    const after = await sourceState(root, childEnv, before);
    const outputs = await outputState(directory);
    if (!outputs) throw new Error('内置 Web 构建产物不完整，未保存开发缓存');
    if (after?.digest === before.digest)
      await writeJson(marker, { format: 1, directory, inputs: after, outputs });
  }
  return { cached: false, durationMs: Math.round(performance.now() - started) };
}
