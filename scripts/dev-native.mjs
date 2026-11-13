import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  AUTHORIZATION_TARGETS,
  authorizationExecutable,
} from '../packages/native/authorization.mjs';
import { manifestValidity } from '../packages/native/validity.mjs';
import {
  acquireProcessLock,
  exists,
  hashFile,
  readCache,
  readJson,
  writeJson,
} from './dev-prepare.mjs';
import { runCommand, startupLog } from './dev-process.mjs';
import { prepareDress } from './dev-dress.mjs';

const kinds = ['font', 'bubble', 'widget'];
const inputs = [
  'Cargo.toml',
  'Cargo.lock',
  'build.rs',
  'build_support',
  'dress-packer',
  'rust-toolchain',
  'rust-toolchain.toml',
  '.cargo',
  'authorization-helper/Cargo.toml',
  'src',
  'vendor',
  ...kinds.map((kind) => `resources/dress/${kind}_resources`),
];
const copy = (from, to) => copyFile(from, to, constants.COPYFILE_FICLONE);

export function nativePlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const target = AUTHORIZATION_TARGETS[key];
  if (!target) throw new Error(`native 暂不支持 ${key}`);
  return {
    key,
    target,
    directory: `native/${platform}/${arch}`,
    library:
      platform === 'win32'
        ? 'nt_helper.dll'
        : platform === 'darwin'
          ? 'libnt_helper.dylib'
          : 'libnt_helper.so',
    helper: authorizationExecutable(key),
  };
}

export async function nativeSourceFingerprint(
  source,
  { env = process.env, platform = nativePlatform(), run = runCommand } = {},
) {
  const listed = await run(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs],
    { cwd: source, env, capture: true },
  );
  // 原始装扮包通常被 Git 忽略，但它们确实参与打包，必须显式纳入指纹。
  const files = [
    ...new Set([
      ...listed.split('\0').filter(Boolean),
      ...kinds.map((kind) => `resources/dress/${kind}_resources`),
      '.cargo/config',
      '.cargo/config.toml',
    ]),
  ].sort();
  const hash = createHash('sha256').update(
    `weq-dev-native-v3\0${resolve(source)}\0${platform.target}\0`,
  );
  for (const name of [
    'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS',
    'RUSTUP_TOOLCHAIN',
    'CC',
    'CXX',
    'CFLAGS',
    'CXXFLAGS',
  ])
    hash.update(`${name}=${env[name] ?? ''}\0`);
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

export function nativeFiles(platform = nativePlatform(), { withDress = true } = {}) {
  return [
    `${platform.directory}/nt_helper.node`,
    ...(withDress ? kinds.map((kind) => `resources/dress/${kind}.dat`) : []),
  ];
}

export async function bundleMatches(
  root,
  marker,
  platform = nativePlatform(),
  { withDress = true } = {},
) {
  if (!marker || !Array.isArray(marker.files)) return false;
  for (const path of nativeFiles(platform, { withDress })) {
    const expected = marker.files.find((entry) => entry.path === path)?.sha256;
    if (
      !/^[a-f0-9]{64}$/.test(expected ?? '') ||
      !(await exists(join(root, path))) ||
      (await hashFile(join(root, path))) !== expected
    )
      return false;
  }
  return true;
}

export async function verifyNativeBundle(
  bundle,
  root,
  { local = false, platform = nativePlatform(), run = runCommand, env = process.env } = {},
) {
  // 验证子进程先退出，安装进程自身不持有 .node，Windows 也能替换目标文件。
  await run(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const nt = require(process.argv[1]);
    assert.equal(nt.getInitStatus(), 0, 'native 初始化失败或构建已过期');
    assert.equal(nt.getBuildInfo().isDev, process.argv[3] === 'local', 'native 来源模式不一致');
    for (const kind of process.argv[3] === 'local' ? ['font', 'bubble', 'widget'] : []) {
      const { response: { items } } = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'resources/dress', 'ranking-' + kind + '.json')));
      assert(items.slice(0, 20).some(({ item }) => ['config.json', 'main', 'fzfont', 'aio_50.png'].some(part =>
        nt.queryDressResourceUrl(kind, String(item.itemId), part))), kind + ' 装扮资源不匹配');
    }
  `,
      join(bundle, platform.directory, 'nt_helper.node'),
      root,
      local ? 'local' : 'release',
    ],
    {
      cwd: root,
      env: { ...env, NT_HELPER_DRESS_DIR: join(bundle, 'resources/dress') },
      capture: true,
    },
  );
}

export async function assertNativeUnused(
  root,
  { platform = nativePlatform(), run = runCommand } = {},
) {
  const addon = join(root, platform.directory, 'nt_helper.node');
  if (!(await exists(addon))) return;
  if (process.platform === 'darwin') {
    let pids;
    try {
      pids = await run('/usr/sbin/lsof', ['-t', addon], { capture: true });
    } catch (error) {
      if (error.exitCode === 1) return;
      throw error;
    }
    if (pids.trim())
      throw new Error('当前仓库的 native 正被使用，请先退出相应 WeQ 或 Web 开发进程');
  } else if (process.platform === 'linux') {
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if ((await readFile(`/proc/${pid}/maps`, 'utf8')).includes(addon))
          throw new Error('当前仓库的 native 正被使用，请先退出相应 WeQ 或 Web 开发进程');
      } catch (error) {
        if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
    }
  }
  // Windows 的已加载 DLL 由系统文件共享规则阻止替换，安装事务会恢复已经替换的文件。
}

export async function installNativeBundle({
  bundle,
  root,
  marker,
  platform = nativePlatform(),
  verify = verifyNativeBundle,
  unused = assertNativeUnused,
  replace = rename,
  local = false,
  withDress = true,
}) {
  const native = join(root, 'native');
  await mkdir(native, { recursive: true });
  const staging = await mkdtemp(join(native, '.dev-install-'));
  const changed = [];
  let retained = false;
  try {
    const paths = nativeFiles(platform, { withDress });
    const helper = `${platform.directory}/${platform.helper}`;
    if (await exists(join(bundle, helper))) paths.push(helper);
    await verify(bundle, root, { local, platform });
    const files = [];
    for (const path of paths) {
      const dest = join(staging, path);
      await mkdir(dirname(dest), { recursive: true });
      await copy(join(bundle, path), dest);
      files.push({ path, sha256: await hashFile(dest) });
    }
    const next = {
      ...marker,
      files: [...(marker.files ?? []).filter((entry) => !paths.includes(entry.path)), ...files],
    };
    await writeJson(join(staging, '.installed.json'), next);
    await unused(root, { platform });
    for (const [index, path] of [...paths, 'native/.installed.json'].entries()) {
      const destination = join(root, path);
      await mkdir(dirname(destination), { recursive: true });
      const backup = join(staging, `previous-${index}`);
      const existed = await exists(destination);
      if (existed) await copy(destination, backup);
      await replace(
        path === 'native/.installed.json' ? join(staging, '.installed.json') : join(staging, path),
        destination,
      );
      changed.push({ destination, backup, existed });
    }
    return next;
  } catch (error) {
    const errors = [error];
    for (const { destination, backup, existed } of changed.reverse()) {
      try {
        if (existed) await rename(backup, destination);
        else await rm(destination);
      } catch (restoreError) {
        errors.push(restoreError);
        retained = true;
      }
    }
    if (retained) throw new AggregateError(errors, `安装恢复未完成，恢复文件保留在 ${staging}`);
    throw error;
  } finally {
    if (!retained) await rm(staging, { recursive: true, force: true });
  }
}

export async function prepareNative(
  root,
  config,
  {
    env = process.env,
    run = runCommand,
    log = startupLog,
    verify = verifyNativeBundle,
    install = installNativeBundle,
    unused = assertNativeUnused,
    platform = nativePlatform(),
  } = {},
) {
  const marker = await readCache(join(root, 'native/.installed.json'));
  const options = { env, run, platform };
  if (config.mode === 'local') {
    const source = config.source;
    if (!(await exists(join(source, 'Cargo.toml'))))
      throw new Error(`找不到 native 源码：${source}`);
    const sourceFingerprint = await nativeSourceFingerprint(source, options);
    if (
      marker?.localBuild?.sourceFingerprint === sourceFingerprint &&
      marker.localBuild.platform === platform.key &&
      (await bundleMatches(root, marker, platform))
    ) {
      await verify(root, root, { ...options, local: true });
      log('本地 native 与源码一致，复用现有构建', 'debug', 'native');
      return;
    }
    await unused(root, options);
    const buildEnv = {
      ...env,
      NT_HELPER_PACK_DRESS: '0',
      CARGO_TERM_COLOR: 'never',
    };
    delete buildEnv.BUILD_TIMESTAMP;
    delete buildEnv.CARGO_BUILD_TARGET;
    let building = true;
    try {
      const metadata = JSON.parse(
        await run('cargo', ['metadata', '--no-deps', '--format-version', '1', '--locked'], {
          cwd: source,
          env: buildEnv,
          capture: true,
        }),
      );
      const target = metadata.target_directory;
      await mkdir(target, { recursive: true });
      const lock = join(target, '.weq-dev-build-lock');
      // 同一 native 源码的装扮缓存和编译目录跨 WeQ checkout 共用。
      const release = await acquireProcessLock(lock);
      let staging;
      try {
        const commit = (
          await run('git', ['rev-parse', 'HEAD'], { cwd: source, capture: true })
        ).trim();
        const dress = await prepareDress(source, target, commit, config.jobs, {
          run,
          env: buildEnv,
          log,
        });
        buildEnv.DRESS_KEY_SEED = dress.seed;
        const started = performance.now();
        log(`正在编译本地 native（${commit.slice(0, 7)}；装扮资源已独立准备）`, 'info', 'native');
        await run(
          'cargo',
          [
            'build',
            '--release',
            '--locked',
            '--lib',
            '--target',
            platform.target,
            '-j',
            String(config.jobs),
          ],
          { cwd: source, env: buildEnv, log, scope: 'native' },
        );
        building = false;
        if (sourceFingerprint !== (await nativeSourceFingerprint(source, options)))
          throw new Error('编译期间 native 输入发生变化，未安装，请重试');
        staging = await mkdtemp(join(target, '.weq-dev-native-'));
        for (const path of nativeFiles(platform))
          await mkdir(dirname(join(staging, path)), { recursive: true });
        await copy(
          join(target, platform.target, 'release', platform.library),
          join(staging, platform.directory, 'nt_helper.node'),
        );
        for (const kind of kinds)
          await copy(
            join(dress.directory, `${kind}.dat`),
            join(staging, `resources/dress/${kind}.dat`),
          );
        const localBuild = {
          source,
          sourceFingerprint,
          commit,
          platform: platform.key,
          pairedDress: true,
          dressFingerprint: dress.fingerprint,
          dressSeed: dress.seed,
          isDev: true,
          installedAt: new Date().toISOString(),
        };
        await install({
          bundle: staging,
          root,
          marker: { ...marker, localBuild },
          platform,
          local: true,
          verify: (bundle, root, flags) => verify(bundle, root, { ...options, ...flags }),
          unused,
        });
        log(
          `本地 native 编译、验证及配套资源安装完成（耗时 ${((performance.now() - started) / 1000).toFixed(1)}s）`,
          'info',
          'native',
        );
      } finally {
        if (staging) await rm(staging, { recursive: true, force: true });
        await release();
      }
    } catch (error) {
      if (!building || [130, 143].includes(error.exitCode)) throw error;
      const local = Boolean(marker?.localBuild);
      try {
        if (
          (!local && manifestValidity(marker).expired) ||
          !(await bundleMatches(root, marker, platform, { withDress: local }))
        )
          throw new Error('没有完整且有效的已安装构建');
        await verify(root, root, { ...options, local });
      } catch (fallbackError) {
        if ([130, 143].includes(fallbackError.exitCode)) throw fallbackError;
        log(`现有 native 无法复用：${fallbackError.message}`, 'warn', 'native');
        throw error;
      }
      log(
        `本地 native 编译失败：${error.message}；复用现有构建继续启动（未包含本次源码改动）`,
        'warn',
        'native',
      );
    }
    return;
  }

  const pin = await readJson(join(root, 'native/pinned.json'), null);
  const tag = env.NT_HELPER_VERSION ?? pin?.tag;
  if (typeof tag !== 'string' || !tag.trim() || tag === 'latest')
    throw new Error(
      'release 模式需要 native/pinned.json 或 NT_HELPER_VERSION 指定明确版本，不自动选择 latest',
    );
  const origin = {
    repository: env.NT_HELPER_RELEASE_REPO ?? 'weq-devs/nt_helper_release',
    baseUrl: env.NT_HELPER_RELEASE_BASE_URL ?? '',
  };
  const sameOrigin = marker?.devSource
    ? JSON.stringify(marker.devSource) === JSON.stringify(origin)
    : origin.repository === 'weq-devs/nt_helper_release' && origin.baseUrl === '';
  if (
    !marker?.localBuild &&
    marker?.tag === tag &&
    sameOrigin &&
    (await bundleMatches(root, marker, platform, { withDress: false }))
  ) {
    if (manifestValidity(marker).expired)
      throw new Error(
        `native ${tag} 已过期，请验证并升级项目版本锚；重新下载同一版本不会延长有效期`,
      );
    await verify(root, root, { ...options, local: false });
    log(`发布版 native 已就绪（${tag}）`, 'debug', 'native');
    return;
  }
  await unused(root, options);
  await mkdir(join(root, 'native'), { recursive: true });
  const staging = await mkdtemp(join(root, 'native/.dev-fetch-'));
  try {
    log(`正在获取发布版 native（${origin.repository}@${tag}）`, 'info', 'native');
    await run(
      process.execPath,
      [
        join(root, 'scripts/fetch-native.mjs'),
        '--root',
        staging,
        '--version',
        tag,
        '--no-dress',
        '--verify',
      ],
      { cwd: root, env, log, scope: 'native' },
    );
    const downloaded = await readJson(join(staging, 'native/.installed.json'));
    if (
      !downloaded ||
      downloaded.tag !== tag ||
      !(await bundleMatches(staging, downloaded, platform, { withDress: false }))
    )
      throw new Error('下载后的 native 来源或文件清单不完整');
    await install({
      bundle: staging,
      root,
      marker: { ...downloaded, devSource: origin },
      platform,
      withDress: false,
      verify: (bundle, root, flags) => verify(bundle, root, { ...options, ...flags }),
      unused,
    });
    log(`发布版 native 已验证并安装（${tag}）`, 'info', 'native');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
