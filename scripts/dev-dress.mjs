import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hashFile, readCache, writeJson } from './dev-prepare.mjs';

const kinds = ['font', 'bubble', 'widget'];

async function dressFingerprint(source, { run, env }) {
  const listed = await run(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'Cargo.toml',
      'Cargo.lock',
      'dress-packer',
      'build_support',
      '.cargo',
      'rust-toolchain',
      'rust-toolchain.toml',
    ],
    { cwd: source, env, capture: true },
  );
  const files = [
    ...new Set([
      ...listed.split('\0').filter(Boolean),
      ...kinds.map((kind) => `resources/dress/${kind}_resources`),
    ]),
  ].sort();
  const hash = createHash('sha256').update('weq-dev-dress-v1\0');
  for (const path of files) {
    hash.update(`${path}\0`);
    try {
      hash.update(await hashFile(join(source, path)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('missing');
    }
  }
  return hash.digest('hex');
}

async function dressMatches(directory, seed) {
  const manifest = await readCache(join(directory, 'dress-build.json'));
  if (manifest?.format !== 1 || manifest.commit !== seed) return false;
  for (const kind of kinds) {
    const expected = manifest.files?.[kind]?.sha256;
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) return false;
    try {
      if ((await hashFile(join(directory, `${kind}.dat`))) !== expected) return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }
  return true;
}

// 调用方持有 native 源码构建锁；缓存独立于普通 Rust 源码及其提交。
export async function prepareDress(source, target, commit, jobs, { run, env, log }) {
  const directory = join(target, '.weq-dev-dress');
  const fingerprint = await dressFingerprint(source, { run, env });
  const previous = await readCache(join(directory, '.weq-dev.json'));
  if (
    previous?.fingerprint === fingerprint &&
    /^[a-f0-9]{40}$/.test(previous.seed ?? '') &&
    (await dressMatches(directory, previous.seed))
  ) {
    log('装扮输入未变化，复用独立打包缓存', 'debug', 'native');
    return { directory, seed: previous.seed, fingerprint };
  }
  const staging = await mkdtemp(join(target, '.weq-dev-dress-'));
  const output = join(staging, 'output');
  try {
    const started = performance.now();
    log('正在独立加工装扮资源（仅输入或打包工具变化时执行）', 'info', 'native');
    await run(
      'cargo',
      [
        'run',
        '--locked',
        '--release',
        '-p',
        'nt-helper-dress-pack',
        '-j',
        String(jobs),
        '--',
        join(source, 'resources/dress'),
        output,
      ],
      { cwd: source, env: { ...env, DRESS_KEY_SEED: commit }, log, scope: 'native' },
    );
    if (!(await dressMatches(output, commit))) throw new Error('装扮打包产物或来源哈希不完整');
    if (fingerprint !== (await dressFingerprint(source, { run, env })))
      throw new Error('装扮打包期间输入发生变化，未安装，请重试');
    await writeJson(join(output, '.weq-dev.json'), { fingerprint, seed: commit });
    await rm(directory, { recursive: true, force: true });
    await rename(output, directory);
    log(
      `装扮资源准备完成（耗时 ${((performance.now() - started) / 1000).toFixed(1)}s）`,
      'info',
      'native',
    );
    return { directory, seed: commit, fingerprint };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
