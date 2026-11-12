import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  bundleMatches,
  installNativeBundle,
  nativeFiles,
  nativePlatform,
  nativeSourceFingerprint,
  prepareNative,
} from './dev-native.mjs';
import { exists, hashFile, readJson, writeJson } from './dev-prepare.mjs';
import { runCommand } from './dev-process.mjs';

const silent = () => {};
const noop = async () => {};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'weq native fixture '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'WeQ');
  const bundle = join(directory, 'bundle');
  await mkdir(root);
  await mkdir(bundle);
  return { root, bundle, directory, platform: nativePlatform() };
}
async function fill(directory, platform, prefix) {
  for (const path of nativeFiles(platform)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), `${prefix}-${path}`);
  }
}
async function marker(directory, platform, extra = {}) {
  return {
    tag: 'fixture-tag',
    ...extra,
    files: await Promise.all(
      nativeFiles(platform).map(async (path) => ({
        path,
        sha256: await hashFile(join(directory, path)),
      })),
    ),
  };
}
async function sourceFixture(t) {
  const options = await fixture(t);
  const source = join(options.directory, 'native source');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'Cargo.toml'), '[package]\nname="nt-helper"');
  await writeFile(join(source, 'src/lib.rs'), 'fixture source');
  await writeFile(join(source, '.gitignore'), 'resources/dress/*_resources\ntarget/\n');
  await mkdir(join(source, 'resources/dress'), { recursive: true });
  for (const kind of ['font', 'bubble', 'widget'])
    await writeFile(join(source, `resources/dress/${kind}_resources`), `raw-${kind}`);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  return { ...options, source };
}

test('五个平台按 Rust 目标和实际 cdylib 文件名选择产物，不沿用 macOS 路径', () => {
  for (const [platform, arch, target, library] of [
    ['darwin', 'arm64', 'aarch64-apple-darwin', 'libnt_helper.dylib'],
    ['darwin', 'x64', 'x86_64-apple-darwin', 'libnt_helper.dylib'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu', 'libnt_helper.so'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu', 'libnt_helper.so'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc', 'nt_helper.dll'],
  ]) {
    const result = nativePlatform(platform, arch);
    assert.equal(result.target, target);
    assert.equal(result.library, library);
    assert.equal(result.directory, `native/${platform}/${arch}`);
  }
  assert.throws(() => nativePlatform('win32', 'arm64'), /暂不支持/);
});

test('源码指纹包含未提交、新增、删除、被 Git 忽略的装扮输入和构建环境，不包含文档', async (t) => {
  const { source } = await sourceFixture(t);
  const original = await nativeSourceFingerprint(source);
  await writeFile(join(source, 'README.md'), 'docs');
  assert.equal(await nativeSourceFingerprint(source), original);
  for (const path of ['src/lib.rs', 'src/new.rs', 'resources/dress/font_resources']) {
    let before;
    try {
      before = await readFile(join(source, path));
    } catch {}
    await writeFile(join(source, path), 'changed');
    assert.notEqual(await nativeSourceFingerprint(source), original, path);
    if (before) await writeFile(join(source, path), before);
    else await rm(join(source, path));
  }
  assert.notEqual(
    await nativeSourceFingerprint(source, { env: { ...process.env, RUSTFLAGS: '--cfg fixture' } }),
    original,
  );
  await rm(join(source, 'src/lib.rs'));
  assert.notEqual(await nativeSourceFingerprint(source), original);
});

test('配套安装与来源记录成功，失败时恢复所有旧文件及原记录', async (t) => {
  const { root, bundle, platform } = await fixture(t);
  await fill(root, platform, 'old');
  await fill(bundle, platform, 'new');
  const old = await marker(root, platform, { keep: true });
  await writeJson(join(root, 'native/.installed.json'), old);
  let count = 0;
  await assert.rejects(
    installNativeBundle({
      root,
      bundle,
      platform,
      marker: { localBuild: { commit: 'new' } },
      verify: noop,
      unused: noop,
      replace: async (...args) => {
        if (++count === 4) throw new Error('write failed');
        await rename(...args);
      },
    }),
    /write failed/,
  );
  assert.deepEqual(await readJson(join(root, 'native/.installed.json')), old);
  assert.equal(await bundleMatches(root, old, platform), true);
  const next = await installNativeBundle({
    root,
    bundle,
    platform,
    marker: { ...old, localBuild: { commit: 'new' } },
    verify: noop,
    unused: noop,
  });
  assert.equal(next.keep, true);
  assert.equal(next.localBuild.commit, 'new');
  assert.equal(await bundleMatches(root, next, platform), true);
  assert(!(await readdir(join(root, 'native'))).some((path) => path.startsWith('.dev-install-')));
});

test('验证与进程占用失败不替换；首次安装失败清理本轮新增文件', async (t) => {
  for (const hook of ['verify', 'unused', 'replace']) {
    const { root, bundle, platform } = await fixture(t);
    await fill(bundle, platform, 'new');
    let count = 0;
    await assert.rejects(
      installNativeBundle({
        root,
        bundle,
        platform,
        marker: {},
        verify: noop,
        unused: noop,
        [hook]: async (...args) => {
          if (hook === 'replace' && ++count < 3) return rename(...args);
          throw new Error('blocked');
        },
      }),
      /blocked/,
    );
    for (const path of nativeFiles(platform)) assert.equal(await exists(join(root, path)), false);
  }
});

test('release 首次补全后离线复用，损坏文件、切换发布仓和 local 记录都会重新成套取回', async (t) => {
  const { root, platform } = await fixture(t);
  await writeJson(join(root, 'native/pinned.json'), { tag: 'fixture-tag' });
  let fetches = 0;
  let verifies = 0;
  const run = async (command, args) => {
    assert.equal(command, process.execPath);
    assert(args.includes('--verify'));
    assert.equal(args[args.indexOf('--version') + 1], 'fixture-tag');
    const staging = args[args.indexOf('--root') + 1];
    assert.notEqual(staging, root);
    fetches++;
    await fill(staging, platform, `fetch-${fetches}`);
    await writeJson(join(staging, 'native/.installed.json'), await marker(staging, platform));
  };
  const options = {
    run,
    log: silent,
    unused: noop,
    verify: async () => {
      verifies++;
    },
  };
  await prepareNative(root, { mode: 'release' }, options);
  await prepareNative(root, { mode: 'release' }, options);
  assert.equal(fetches, 1);
  assert.equal(verifies, 2);
  await writeFile(join(root, nativeFiles(platform)[1]), 'broken');
  await prepareNative(root, { mode: 'release' }, options);
  assert.equal(fetches, 2);
  await prepareNative(
    root,
    { mode: 'release' },
    { ...options, env: { NT_HELPER_RELEASE_REPO: 'fixture/other' } },
  );
  assert.equal(fetches, 3);
  const installed = await readJson(join(root, 'native/.installed.json'));
  installed.localBuild = { sourceFingerprint: 'local' };
  await writeJson(join(root, 'native/.installed.json'), installed);
  await prepareNative(root, { mode: 'release' }, options);
  assert.equal(fetches, 4);
  assert.equal((await readJson(join(root, 'native/.installed.json'))).localBuild, undefined);
});

test('release 不暗选 latest、过期不重复下载，失败验证不安装或切换来源', async (t) => {
  const { root, platform } = await fixture(t);
  const forbidden = async () => {
    throw new Error('must not fetch');
  };
  await assert.rejects(prepareNative(root, { mode: 'release' }, { run: forbidden }), /明确版本/);
  await fill(root, platform, 'old');
  await writeJson(join(root, 'native/pinned.json'), { tag: 'fixture-tag' });
  await writeJson(
    join(root, 'native/.installed.json'),
    await marker(root, platform, { expiresAt: '2020-01-01T00:00:00Z' }),
  );
  await assert.rejects(prepareNative(root, { mode: 'release' }, { run: forbidden }), /已过期/);
  await writeJson(join(root, 'native/.installed.json'), await marker(root, platform));
  await assert.rejects(
    prepareNative(
      root,
      { mode: 'release' },
      {
        run: forbidden,
        verify: async () => {
          throw new Error('invalid native');
        },
      },
    ),
    /invalid native/,
  );
});

test('local 按目标编译、移除发布时间戳、保持成套验证，源码或文件变化才重编译', async (t) => {
  const { root, source, directory, platform } = await sourceFixture(t);
  const target = join(directory, 'target');
  let builds = 0;
  let verifications = 0;
  const run = async (command, args, options) => {
    if (command === 'git') return runCommand(command, args, options);
    assert.equal(command, 'cargo');
    assert.equal(options.env.BUILD_TIMESTAMP, undefined);
    assert.equal(options.env.CARGO_BUILD_TARGET, undefined);
    assert.equal(options.env.NT_HELPER_PACK_DRESS, '1');
    if (args[0] === 'metadata') return JSON.stringify({ target_directory: target });
    builds++;
    assert.equal(args[args.indexOf('--target') + 1], platform.target);
    await mkdir(join(target, platform.target, 'release'), { recursive: true });
    await writeFile(join(target, platform.target, 'release', platform.library), `native-${builds}`);
    for (const kind of ['font', 'bubble', 'widget'])
      await writeFile(join(source, `resources/dress/${kind}.dat`), `dat-${builds}-${kind}`);
  };
  const options = {
    run,
    log: silent,
    unused: noop,
    env: { ...process.env, BUILD_TIMESTAMP: '123', CARGO_BUILD_TARGET: 'wrong-target' },
    verify: async (_bundle, _root, flags) => {
      assert.equal(flags.local, true);
      verifications++;
    },
  };
  const config = { mode: 'local', source, jobs: 2 };
  await prepareNative(root, config, options);
  await prepareNative(root, config, options);
  assert.equal(builds, 1);
  assert.equal(verifications, 2);
  await writeFile(join(source, 'src/lib.rs'), 'changed');
  await prepareNative(root, config, options);
  assert.equal(builds, 2);
  await writeFile(join(root, nativeFiles(platform)[0]), 'broken');
  await prepareNative(root, config, options);
  assert.equal(builds, 3);
  assert.equal(await exists(join(target, '.weq-dev-build-lock')), false);
});

test('local 编译失败和编译期间源码变化不替换、不取发布版，并释放构建锁', async (t) => {
  for (const changed of [false, true]) {
    const { root, source, directory, platform } = await sourceFixture(t);
    await fill(root, platform, 'old');
    const old = await marker(root, platform);
    await writeJson(join(root, 'native/.installed.json'), old);
    const target = join(directory, 'target');
    const run = async (command, args, options) => {
      if (command === 'git') return runCommand(command, args, options);
      assert.equal(command, 'cargo');
      if (args[0] === 'metadata') return JSON.stringify({ target_directory: target });
      if (changed) await writeFile(join(source, 'src/lib.rs'), 'changed during build');
      else throw new Error('compile failed');
    };
    await assert.rejects(
      prepareNative(root, { mode: 'local', source, jobs: 2 }, { run, log: silent, unused: noop }),
      changed ? /输入发生变化/ : /compile failed/,
    );
    assert.equal(await bundleMatches(root, old, platform), true);
    assert.deepEqual(await readJson(join(root, 'native/.installed.json')), old);
    assert.equal(await exists(join(target, '.weq-dev-build-lock')), false);
  }
});
