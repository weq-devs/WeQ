import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { prepareDress } from './dev-dress.mjs';

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
  await mkdir(join(source, 'build_support'), { recursive: true });
  await mkdir(join(source, 'dress-packer/src'), { recursive: true });
  await writeFile(join(source, 'dress-packer/src/main.rs'), 'fixture packer');
  await writeFile(join(source, 'build_support/dress.rs'), 'fixture dress packer');
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

async function fakeDressPack(args, options) {
  assert.equal(args[args.indexOf('-p') + 1], 'nt-helper-dress-pack');
  assert(args.includes('--release'));
  const output = args.at(-1);
  await mkdir(output);
  const files = {};
  for (const kind of ['font', 'bubble', 'widget']) {
    const path = join(output, `${kind}.dat`);
    await writeFile(path, `packed-${kind}-${options.env.DRESS_KEY_SEED}`);
    files[kind] = { sha256: await hashFile(path) };
  }
  await writeJson(join(output, 'dress-build.json'), {
    format: 1,
    commit: options.env.DRESS_KEY_SEED,
    files,
  });
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
  for (const path of [
    'src/lib.rs',
    'src/new.rs',
    'build_support/dress.rs',
    'resources/dress/font_resources',
  ]) {
    let before;
    try {
      before = await readFile(join(source, path));
    } catch {}
    await writeFile(join(source, path), 'changed');
    assert.notEqual(await nativeSourceFingerprint(source), original, path);
    if (before) await writeFile(join(source, path), before);
    else await rm(join(source, path));
  }
  for (const [name, value] of [
    ['RUSTFLAGS', '--cfg fixture'],
    ['CARGO_INCREMENTAL', '0'],
    ['CARGO_PROFILE_WEQ_DEV_OPT_LEVEL', '1'],
  ])
    assert.notEqual(
      await nativeSourceFingerprint(source, { env: { ...process.env, [name]: value } }),
      original,
      name,
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
  await writeFile(join(root, nativeFiles(platform)[0]), 'broken');
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

test('release 开发启动不下载装扮索引，缺少三份 dat 仍可离线复用 native', async (t) => {
  const { root, platform } = await fixture(t);
  await writeJson(join(root, 'native/pinned.json'), { tag: 'fixture-tag' });
  let fetches = 0;
  const options = {
    log: silent,
    unused: noop,
    verify: noop,
    run: async (_command, args) => {
      assert(args.includes('--no-dress'));
      fetches++;
      const staging = args[args.indexOf('--root') + 1];
      const path = `${platform.directory}/nt_helper.node`;
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), 'release-native');
      await writeJson(join(staging, 'native/.installed.json'), {
        tag: 'fixture-tag',
        files: [{ path, sha256: await hashFile(join(staging, path)) }],
      });
    },
  };
  await prepareNative(root, { mode: 'release' }, options);
  await prepareNative(root, { mode: 'release' }, options);
  assert.equal(fetches, 1);
  for (const kind of ['font', 'bubble', 'widget'])
    assert.equal(await exists(join(root, `resources/dress/${kind}.dat`)), false);
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
  let packs = 0;
  let packedSeed;
  let verifications = 0;
  const run = async (command, args, options) => {
    if (command === 'git') return runCommand(command, args, options);
    assert.equal(command, 'cargo');
    assert.equal(options.env.BUILD_TIMESTAMP, undefined);
    assert.equal(options.env.CARGO_BUILD_TARGET, undefined);
    assert.equal(options.env.NT_HELPER_PACK_DRESS, '0');
    if (args[0] === 'metadata') return JSON.stringify({ target_directory: target });
    if (args[0] === 'run') {
      packs++;
      packedSeed = options.env.DRESS_KEY_SEED;
      return fakeDressPack(args, options);
    }
    builds++;
    assert.equal(options.env.DRESS_KEY_SEED, packedSeed, 'native 使用缓存装扮的同一密钥');
    assert.equal(args[args.indexOf('--target') + 1], platform.target);
    assert.equal(args[args.indexOf('--profile') + 1], 'weq-dev');
    assert(!args.includes('--release'));
    assert.equal(
      args[args.indexOf('--config') + 1],
      fileURLToPath(new URL('./dev-native.cargo.toml', import.meta.url)),
    );
    await mkdir(join(target, platform.target, 'weq-dev'), { recursive: true });
    await writeFile(join(target, platform.target, 'weq-dev', platform.library), `native-${builds}`);
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
  assert.equal(packs, 1);
  assert.equal(verifications, 2);
  const installed = await readJson(join(root, 'native/.installed.json'));
  assert.equal(installed.localBuild.profile, 'weq-dev');
  await writeJson(join(root, 'native/.installed.json'), {
    ...installed,
    localBuild: { ...installed.localBuild, profile: 'release' },
  });
  await prepareNative(root, config, options);
  assert.equal(builds, 2, '旧 release 配置不能冒充快速开发构建');
  await writeFile(join(source, 'src/lib.rs'), 'changed');
  await prepareNative(root, config, options);
  assert.equal(builds, 3);
  assert.equal(packs, 1, '只改 native 源码不重新打包');
  await writeFile(join(root, nativeFiles(platform)[0]), 'broken');
  await prepareNative(root, config, options);
  assert.equal(builds, 4);
  assert.equal(packs, 1, 'native 损坏不重新打包');
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-am', 'change'],
    { cwd: source },
  );
  await writeFile(join(source, 'src/lib.rs'), 'another change');
  await prepareNative(root, config, options);
  assert.equal(packs, 1, '源码提交变化不重新打包或更换缓存密钥');
  await writeFile(join(source, 'resources/dress/font_resources'), 'changed raw');
  await prepareNative(root, config, options);
  assert.equal(packs, 2, '原始资源变化才重新打包');
  await writeFile(join(source, 'dress-packer/src/main.rs'), 'changed packer');
  await prepareNative(root, config, options);
  assert.equal(packs, 3, '打包工具变化重新打包');
  assert.equal(await exists(join(target, '.weq-dev-build-lock')), false);
});

test('五个平台均安装 weq-dev 产物，不误取同目录的旧 release 库', async (t) => {
  for (const [os, arch] of [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
  ]) {
    const { root, source, directory } = await sourceFixture(t);
    const platform = nativePlatform(os, arch);
    const target = join(directory, 'target');
    const run = async (command, args, options) => {
      if (command === 'git') return runCommand(command, args, options);
      if (args[0] === 'metadata') return JSON.stringify({ target_directory: target });
      if (args[0] === 'run') return fakeDressPack(args, options);
      assert.equal(args[args.indexOf('--target') + 1], platform.target);
      assert.equal(args[args.indexOf('--profile') + 1], 'weq-dev');
      for (const profile of ['release', 'weq-dev']) {
        await mkdir(join(target, platform.target, profile), { recursive: true });
        await writeFile(join(target, platform.target, profile, platform.library), profile);
      }
    };
    await prepareNative(
      root,
      { mode: 'local', source, jobs: 2 },
      { run, platform, log: silent, unused: noop, verify: noop },
    );
    assert.equal(
      await readFile(join(root, platform.directory, 'nt_helper.node'), 'utf8'),
      'weq-dev',
    );
  }
});

test('真实 Cargo 使用独立增量 profile，依赖保留优化且正式 release 配置不变', async (t) => {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error?.code === 'ENOENT') return t.skip('未安装 Cargo');
  assert.equal(probe.status, 0, probe.stderr);
  const { source, platform } = await sourceFixture(t);
  await writeFile(
    join(source, 'Cargo.toml'),
    `[package]
name = "nt-helper"
version = "0.0.0"
edition = "2021"
[lib]
crate-type = ["cdylib"]
[dependencies]
fixture-dependency = { path = "dependency" }
[profile.release]
lto = true
codegen-units = 1
opt-level = 3
`,
  );
  await mkdir(join(source, 'dependency/src'), { recursive: true });
  await writeFile(
    join(source, 'dependency/Cargo.toml'),
    '[package]\nname="fixture-dependency"\nversion="0.0.0"\nedition="2021"\n',
  );
  await writeFile(join(source, 'dependency/src/lib.rs'), 'pub fn value() -> u32 { 42 }\n');
  await writeFile(
    join(source, 'src/lib.rs'),
    '#[no_mangle]\npub extern "C" fn fixture() -> u32 { fixture_dependency::value() }\n',
  );
  const env = { ...process.env, CARGO_TERM_COLOR: 'never' };
  // 验证本地开发 profile；Cargo 在 CI 环境下会自动关闭增量编译。
  delete env.CI;
  for (const key of Object.keys(env))
    if (
      key.startsWith('CARGO_PROFILE_') ||
      [
        'CARGO_INCREMENTAL',
        'CARGO_BUILD_INCREMENTAL',
        'RUSTFLAGS',
        'CARGO_ENCODED_RUSTFLAGS',
        'CARGO_TARGET_DIR',
        'CARGO_BUILD_TARGET',
      ].includes(key)
    )
      delete env[key];
  const build = (extra) => {
    const result = spawnSync(
      'cargo',
      [
        'build',
        '--offline',
        '--lib',
        '--target',
        platform.target,
        '--message-format=json',
        '-vv',
        ...extra,
      ],
      { cwd: source, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const artifacts = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => message.reason === 'compiler-artifact');
    return { ...result, artifacts };
  };
  const config = fileURLToPath(new URL('./dev-native.cargo.toml', import.meta.url));
  const fast = build(['--profile', 'weq-dev', '--config', config]);
  const main = fast.artifacts.find((message) => message.target.name === 'nt_helper');
  const dependency = fast.artifacts.find((message) => message.target.name === 'fixture_dependency');
  assert.equal(main.profile.opt_level, '2');
  assert.equal(main.profile.debug_assertions, false);
  assert.equal(dependency.profile.opt_level, '3');
  assert(
    (await Promise.all(main.filenames.map((path) => realpath(path)))).includes(
      await realpath(join(source, 'target', platform.target, 'weq-dev', platform.library)),
    ),
  );
  assert.match(fast.stderr, /codegen-units=16/);
  assert.match(fast.stderr, /lto=off/);
  assert.match(fast.stderr, /incremental=/);
  const warm = build(['--locked', '--profile', 'weq-dev', '--config', config]);
  assert(warm.artifacts.every((message) => message.fresh));
  await writeFile(
    join(source, 'src/lib.rs'),
    '#[no_mangle]\npub extern "C" fn fixture() -> u32 { fixture_dependency::value() + 1 }\n',
  );
  const edited = build(['--locked', '--profile', 'weq-dev', '--config', config]);
  assert.equal(
    edited.artifacts.find((message) => message.target.name === 'nt_helper').fresh,
    false,
  );
  assert.equal(
    edited.artifacts.find((message) => message.target.name === 'fixture_dependency').fresh,
    true,
  );
  assert.match(edited.stderr, /incremental=/);
  const release = build(['--locked', '--release']);
  assert.equal(
    release.artifacts.find((message) => message.target.name === 'nt_helper').profile.opt_level,
    '3',
  );
  assert.match(release.stderr, /codegen-units=1(?:\s|`)/);
  assert.doesNotMatch(release.stderr, /incremental=|lto=off/);
});

test('local 编译失败复用通过校验的现有构建，不改来源记录，下次启动仍重试编译', async (t) => {
  for (const local of [false, true]) {
    const { root, source, directory, platform } = await sourceFixture(t);
    await fill(root, platform, 'old');
    const old = await marker(root, platform, local ? { localBuild: { commit: 'old' } } : {});
    await writeJson(join(root, 'native/.installed.json'), old);
    if (!local) for (const path of nativeFiles(platform).slice(1)) await rm(join(root, path));
    const target = join(directory, 'target');
    let builds = 0;
    let verifications = 0;
    const logs = [];
    const options = {
      unused: noop,
      log: (...args) => logs.push(args),
      verify: async (bundle, repo, flags) => {
        assert.equal(bundle, root);
        assert.equal(repo, root);
        assert.equal(flags.local, local);
        verifications++;
      },
      run: async (command, args, flags) => {
        if (command === 'git') return runCommand(command, args, flags);
        assert.equal(command, 'cargo', '不下载发布版');
        if (args[0] === 'metadata') return JSON.stringify({ target_directory: target });
        if (args[0] === 'run') return fakeDressPack(args, flags);
        builds++;
        throw new Error('compile failed');
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await prepareNative(root, { mode: 'local', source, jobs: 2 }, options);
      assert.deepEqual(await readJson(join(root, 'native/.installed.json')), old);
      assert.equal(await exists(join(target, '.weq-dev-build-lock')), false);
    }
    assert.equal(builds, 2);
    assert.equal(verifications, 2);
    assert(
      logs.some(
        ([message, level]) => /compile failed.*复用现有构建/.test(message) && level === 'warn',
      ),
    );
  }
});

test('local 构建准备失败也可复用；没有可用旧构建或主动中止时保留原错误', async (t) => {
  for (const state of [
    'valid',
    'missing',
    'corrupt',
    'dress-missing',
    'expired',
    'unloadable',
    'cancelled',
    'terminated',
  ]) {
    const { root, source, platform } = await sourceFixture(t);
    await fill(root, platform, 'old');
    const old = await marker(root, platform, {
      ...(state === 'expired' ? { expiresAt: '2020-01-01T00:00:00Z' } : {}),
      ...(state === 'dress-missing' ? { localBuild: { commit: 'old' } } : {}),
    });
    if (state !== 'missing') await writeJson(join(root, 'native/.installed.json'), old);
    if (state === 'corrupt') await writeFile(join(root, nativeFiles(platform)[0]), 'broken');
    if (state === 'dress-missing') await rm(join(root, 'resources/dress/widget.dat'));
    const failure = Object.assign(new Error('cargo unavailable'), {
      exitCode: state === 'cancelled' ? 130 : state === 'terminated' ? 143 : 1,
    });
    let verifications = 0;
    const prepare = () =>
      prepareNative(
        root,
        { mode: 'local', source, jobs: 2 },
        {
          unused: noop,
          log: silent,
          run: async (command, args, options) => {
            if (command === 'git') return runCommand(command, args, options);
            throw failure;
          },
          verify: async () => {
            verifications++;
            if (state === 'unloadable') throw new Error('cannot load');
          },
        },
      );
    if (state === 'valid') await prepare();
    else await assert.rejects(prepare(), (error) => error === failure);
    assert.equal(verifications, ['valid', 'unloadable'].includes(state) ? 1 : 0);
  }
});

test('local 源码检查、新产物缺失、验证及安装失败均保留并复用旧构建', async (t) => {
  for (const stage of ['source-missing', 'fingerprint', 'output-missing', 'verify', 'install']) {
    const { root, source, directory, platform } = await sourceFixture(t);
    await fill(root, platform, 'old');
    const old = await marker(root, platform, { localBuild: { commit: 'old' } });
    await writeJson(join(root, 'native/.installed.json'), old);
    if (stage === 'source-missing') await rm(join(source, 'Cargo.toml'));
    const target = join(directory, 'target');
    let reused = 0;
    let builds = 0;
    let replacements = 0;
    const result = await prepareNative(
      root,
      { mode: 'local', source, jobs: 2 },
      {
        log: silent,
        unused: noop,
        run: async (command, args, options) => {
          if (command === 'git') {
            if (stage === 'fingerprint') throw new Error('cannot read source');
            return runCommand(command, args, options);
          }
          assert.equal(command, 'cargo', '不切换到发布版下载');
          if (args[0] === 'metadata') return JSON.stringify({ target_directory: target });
          if (args[0] === 'run') return fakeDressPack(args, options);
          builds++;
          if (stage === 'output-missing') return;
          await mkdir(join(target, platform.target, 'weq-dev'), { recursive: true });
          await writeFile(join(target, platform.target, 'weq-dev', platform.library), 'new');
        },
        verify: async (bundle, _root, flags) => {
          assert.equal(flags.local, true);
          if (bundle === root) reused++;
          else if (stage === 'verify') throw new Error('invalid new native');
        },
        install: (options) =>
          installNativeBundle({
            ...options,
            replace: async (...args) => {
              if (stage === 'install' && ++replacements === 2) throw new Error('install failed');
              return rename(...args);
            },
          }),
      },
    );
    assert.deepEqual(result, { fallback: true }, stage);
    assert.equal(reused, 1, stage);
    assert.equal(builds, ['source-missing', 'fingerprint'].includes(stage) ? 0 : 1, stage);
    assert.deepEqual(await readJson(join(root, 'native/.installed.json')), old, stage);
    assert.equal(await bundleMatches(root, old, platform), true, stage);
    assert(!(await readdir(join(root, 'native'))).some((path) => path.startsWith('.dev-')));
    if (await exists(target))
      assert(
        !(await readdir(target)).some(
          (path) => path.startsWith('.weq-dev-native-') || path === '.weq-dev-build-lock',
        ),
      );
  }
});

test('local 无可用旧构建时保留编译错误；编译期间源码变化复用旧构建并释放构建锁', async (t) => {
  for (const changed of [false, true]) {
    const { root, source, directory, platform } = await sourceFixture(t);
    await fill(root, platform, 'old');
    const old = await marker(root, platform, changed ? {} : { expiresAt: '2020-01-01T00:00:00Z' });
    await writeJson(join(root, 'native/.installed.json'), old);
    const target = join(directory, 'target');
    const run = async (command, args, options) => {
      if (command === 'git') return runCommand(command, args, options);
      assert.equal(command, 'cargo');
      if (args[0] === 'metadata') return JSON.stringify({ target_directory: target });
      if (args[0] === 'run') return fakeDressPack(args, options);
      if (changed) await writeFile(join(source, 'src/lib.rs'), 'changed during build');
      else throw new Error('compile failed');
    };
    let verifications = 0;
    const prepare = () =>
      prepareNative(
        root,
        { mode: 'local', source, jobs: 2 },
        {
          run,
          log: silent,
          unused: noop,
          verify: async () => {
            assert(changed, '编译失败后的过期产物不尝试加载');
            verifications++;
          },
        },
      );
    if (changed) assert.deepEqual(await prepare(), { fallback: true });
    else await assert.rejects(prepare(), /compile failed/);
    assert.equal(verifications, changed ? 1 : 0);
    assert.equal(await bundleMatches(root, old, platform), true);
    assert.deepEqual(await readJson(join(root, 'native/.installed.json')), old);
    assert.equal(await exists(join(target, '.weq-dev-build-lock')), false);
  }
});

test('独立装扮缓存校验哈希、来源与缺件；失败不替换旧缓存或污染源码资源', async (t) => {
  const { source, directory } = await sourceFixture(t);
  const target = join(directory, 'target');
  await mkdir(target);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
  }).trim();
  let packs = 0;
  let failure;
  const options = {
    env: { ...process.env, NT_HELPER_PACK_DRESS: '0' },
    log: silent,
    run: async (command, args, flags) => {
      if (command === 'git') return runCommand(command, args, flags);
      packs++;
      await fakeDressPack(args, flags);
      if (failure === 'throw') throw new Error('pack failed');
      if (failure === 'missing') await rm(join(args.at(-1), 'widget.dat'));
      if (failure === 'changed')
        await writeFile(join(source, 'resources/dress/widget_resources'), 'changed during pack');
    },
  };
  const prepare = () => prepareDress(source, target, commit, 2, options);
  const first = await prepare();
  for (const kind of ['font', 'bubble', 'widget'])
    assert.equal(await exists(join(source, `resources/dress/${kind}.dat`)), false);
  await prepare();
  assert.equal(packs, 1);
  await writeFile(join(first.directory, 'font.dat'), 'corrupt');
  await prepare();
  assert.equal(packs, 2);
  await rm(join(first.directory, 'bubble.dat'));
  await prepare();
  assert.equal(packs, 3);
  const manifestPath = join(first.directory, 'dress-build.json');
  const manifest = await readJson(manifestPath);
  await writeJson(manifestPath, { ...manifest, commit: 'b'.repeat(40) });
  await prepare();
  assert.equal(packs, 4);
  const old = await readFile(join(first.directory, 'font.dat'));
  await writeFile(join(source, 'resources/dress/font_resources'), 'changed input');
  for (failure of ['throw', 'missing', 'changed']) {
    await assert.rejects(prepare(), /pack failed|来源哈希不完整|输入发生变化/);
    assert.deepEqual(await readFile(join(first.directory, 'font.dat')), old);
    assert.deepEqual(await readdir(target), ['.weq-dev-dress']);
  }
});
