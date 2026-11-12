import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { commandOutput, pnpmCommand, runCommand } from './dev-process.mjs';
import {
  dependencyState,
  exists,
  loadConfig,
  prepareDependencies,
  prepareElectron,
  prepareBot,
  prepareNetwork,
  readJson,
  writeJson,
} from './dev-prepare.mjs';
import { startDevelopment, withDevelopmentLock } from './dev.mjs';
import { formatConsoleHeader } from '../packages/service/src/common/console_header.mjs';

const silent = () => {};
const actualPnpm = () =>
  process.env.npm_execpath ??
  execFileSync('pnpm', ['exec', 'node', '-p', 'process.env.npm_execpath'], {
    encoding: 'utf8',
  }).trim();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'weq dev fixture '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['apps/desktop', 'packages'])
    await mkdir(join(root, path), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    name: 'fixture',
    dependencies: { 'fixture-dep': '1' },
  });
  await writeJson(join(root, 'apps/desktop/package.json'), { name: 'desktop' });
  await writeFile(join(root, 'pnpm-lock.yaml'), 'fixture lock');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  return root;
}
async function installed(root) {
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules/.modules.yaml'), 'fixture');
  const manifest = await readJson(join(root, 'package.json'));
  for (const name of Object.keys(manifest.dependencies))
    await writeJson(join(root, 'node_modules', name, 'package.json'), { name, version: '1' });
}

test('配置默认为发布版与独立开发目录；本机覆盖和环境覆盖明确、路径不依赖 cwd', async (t) => {
  const root = await fixture(t);
  assert.equal((await loadConfig(root, {})).native.mode, 'release');
  await writeJson(join(root, 'weq.dev.json'), { native: { jobs: 3 } });
  await writeJson(join(root, 'weq.dev.local.json'), {
    native: { mode: 'local', source: '../native source' },
    userDataDir: null,
  });
  const local = await loadConfig(root, {});
  assert.equal(local.native.source, join(dirname(root), 'native source'));
  assert.equal(local.native.jobs, 3);
  assert.equal(local.userDataDir, null);
  assert.equal((await loadConfig(root, { WEQ_NATIVE_MODE: 'release' })).native.mode, 'release');
  for (const config of [
    { native: { mode: 'unknown' } },
    { native: { mode: 'local' } },
    { native: { jobs: '2' } },
    { typo: true },
    { native: { typo: true } },
    { userDataDir: '' },
  ]) {
    await writeJson(join(root, 'weq.dev.local.json'), config);
    await assert.rejects(loadConfig(root, {}));
  }
});

test('依赖缺失时真实执行 pnpm 入口，缓存命中跳过；清单、锁文件、缺包和损坏记录均触发修复', async (t) => {
  const root = await fixture(t);
  const cli = join(root, 'fake pnpm.cjs');
  await writeFile(
    cli,
    `
const fs = require('node:fs');
const path = require('node:path');
require('node:assert/strict').deepEqual(process.argv.slice(2), ['install', '--frozen-lockfile', '--prefer-offline', '--prod=false']);
fs.mkdirSync('node_modules', { recursive: true });
fs.writeFileSync('node_modules/.modules.yaml', 'fixture');
for (const name of Object.keys(require(path.resolve('package.json')).dependencies)) {
  fs.mkdirSync(path.join('node_modules', name), { recursive: true });
  fs.writeFileSync(path.join('node_modules', name, 'package.json'), JSON.stringify({name}));
}
fs.appendFileSync('installs', '1');
console.log('installed');
`,
  );
  const env = { ...process.env, npm_execpath: cli };
  const prepare = () => prepareDependencies(root, { env, log: silent });
  await prepare();
  await prepare();
  assert.equal(await readFile(join(root, 'installs'), 'utf8'), '1');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'changed');
  await prepare();
  const manifest = await readJson(join(root, 'package.json'));
  manifest.dependencies.extra = '1';
  await writeJson(join(root, 'package.json'), manifest);
  await prepare();
  await rm(join(root, 'node_modules/extra/package.json'));
  await prepare();
  await writeFile(join(root, 'node_modules/.weq-dev-dependencies.json'), '{broken');
  await prepare();
  assert.equal(await readFile(join(root, 'installs'), 'utf8'), '11111');
  await writeFile(join(root, 'node_modules/.modules.yaml'), 'changed externally');
  await prepare();
  assert.equal(await readFile(join(root, 'installs'), 'utf8'), '111111');
  assert.equal((await dependencyState(root, env)).complete, true);
});

test('安装失败或安装期间清单变化不记成功，不启动后续阶段', async (t) => {
  const root = await fixture(t);
  const env = { npm_execpath: '/fixture/pnpm.cjs' };
  await assert.rejects(
    prepareDependencies(root, {
      env,
      log: silent,
      run: async () => {
        throw new Error('install failed');
      },
    }),
    /install failed/,
  );
  assert.equal(await exists(join(root, 'node_modules/.weq-dev-dependencies.json')), false);
  await assert.rejects(
    prepareDependencies(root, {
      env,
      log: silent,
      run: async () => {
        await installed(root);
        await writeFile(join(root, 'pnpm-lock.yaml'), 'new lock');
      },
    }),
    /清单发生变化/,
  );
});

test('Electron 解析使用已清理的子进程环境，不被继承的旧运行时覆盖污染', async (t) => {
  const root = await fixture(t);
  const electron = join(root, 'apps/desktop/node_modules/electron');
  await writeJson(join(root, 'apps/desktop/package.json'), {
    devDependencies: { electron: '99.0.0' },
  });
  await writeJson(join(electron, 'package.json'), {
    name: 'electron',
    version: '99.0.0',
    main: 'index.js',
  });
  await writeFile(
    join(electron, 'index.js'),
    'module.exports = process.env.ELECTRON_OVERRIDE_DIST_PATH || process.execPath;',
  );
  await writeFile(join(electron, 'install.js'), '');
  const env = {
    ...process.env,
    ELECTRON_OVERRIDE_DIST_PATH: '/old/runtime',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const executable = await prepareElectron(root, {
    env,
    log: silent,
    run: async (command, args, options) => {
      if (args[0] === '-p') {
        assert.equal(command, process.execPath);
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
        return '99.0.0';
      }
      assert.equal(options.env.ELECTRON_OVERRIDE_DIST_PATH, undefined);
      return runCommand(command, args, options);
    },
  });
  assert.equal(executable, process.execPath);
  assert.equal(env.ELECTRON_OVERRIDE_DIST_PATH, '/old/runtime');
});

test('一行入口按依赖、宿主、native、网络、启动顺序执行，配置与 Electron 参数传递不经过 shell', async (t) => {
  const root = await fixture(t);
  const events = [];
  let launch;
  const hooks = {
    repo: root,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_OVERRIDE_DIST_PATH: '/old',
      npm_execpath: '/pnpm.cjs',
    },
    log: silent,
    dependencies: async () => events.push('dependencies'),
    electron: async () => events.push('electron'),
    native: async (_root, config) => {
      events.push('native');
      assert.equal(config.mode, 'release');
    },
    network: async () => {
      events.push('network');
      return '/network helper';
    },
    bot: async () => events.push('bot'),
    launch: async (args, environment) => {
      events.push('launch');
      launch = { args, options: { env: environment } };
    },
  };
  await startDevelopment({ ...hooks, args: ['--', '--foo=space value'] });
  assert.deepEqual(events, ['dependencies', 'electron', 'native', 'network', 'bot', 'launch']);
  assert(launch.args.includes(`--user-data-dir=${join(root, '.dev-profile')}`));
  assert(launch.args.includes('--foo=space value'));
  assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(launch.options.env.ELECTRON_OVERRIDE_DIST_PATH, undefined);
  assert.equal(launch.options.env.WEQ_REMOTE_HELPER, '/network helper');
  events.length = 0;
  await startDevelopment({ ...hooks, args: ['--prepare-only'] });
  assert.deepEqual(events, ['dependencies', 'electron', 'native', 'network', 'bot']);
  events.length = 0;
  await assert.rejects(
    startDevelopment({
      ...hooks,
      native: async () => {
        throw new Error('native failed');
      },
    }),
    /native failed/,
  );
  assert.deepEqual(events, ['dependencies', 'electron']);
  events.length = 0;
  await assert.rejects(
    startDevelopment({
      ...hooks,
      unused: async () => {
        throw new Error('in use');
      },
    }),
    /in use/,
  );
  assert.deepEqual(events, []);
  await writeJson(join(root, 'weq.dev.local.json'), { userDataDir: null });
  await startDevelopment(hooks);
  assert(!launch.args.some((arg) => arg.startsWith('--user-data-dir')));
});

test('网络辅助程序复用构建计划并校验缓存，源码与二进制变化均重建', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'tools/remote-network'), { recursive: true });
  await writeFile(join(root, 'tools/remote-network/go.mod'), 'module fixture');
  await writeFile(join(root, 'tools/remote-network/main.go'), 'fixture source');
  let builds = 0;
  const run = async (command, args, options) => {
    assert.equal(command, 'go');
    if (args[0] === 'version') return 'go version fixture';
    builds++;
    assert.equal(options.env.GOOS, 'windows');
    assert.equal(options.env.GOARCH, 'amd64');
    await writeFile(args[args.indexOf('-o') + 1], `binary-${builds}`);
  };
  const options = { platform: 'win32', arch: 'x64', run, log: silent };
  const path = await prepareNetwork(root, options);
  assert(path.endsWith('weq-remote-network.exe'));
  await prepareNetwork(root, options);
  assert.equal(builds, 1);
  await writeFile(path, 'corrupted');
  await prepareNetwork(root, options);
  await writeFile(join(root, 'tools/remote-network/main.go'), 'changed');
  await prepareNetwork(root, options);
  assert.equal(builds, 3);
});

test('机器人运行时按 esbuild 的实际输入缓存，缺失、源码变化和输出损坏时补构建', async (t) => {
  const root = await fixture(t);
  const manifest = await readJson(join(root, 'package.json'));
  manifest.scripts = { 'build:bot': 'fixture-build' };
  await writeJson(join(root, 'package.json'), manifest);
  await writeFile(join(root, 'entry.js'), 'source');
  let builds = 0;
  const options = {
    env: { npm_execpath: '/pnpm.cjs' },
    log: silent,
    run: async (_command, args) => {
      assert.deepEqual(args.slice(1, 3), ['run', 'build:bot']);
      builds++;
      await mkdir(join(root, 'resources/bot-runtime'), { recursive: true });
      await writeFile(join(root, 'resources/bot-runtime/bot.mjs'), `built-${builds}`);
      await writeJson(join(root, '.weq-dev/bot-meta.json'), {
        inputs: { 'entry.js': {} },
      });
    },
  };
  await prepareBot(root, options);
  await prepareBot(root, options);
  assert.equal(builds, 1);
  await writeFile(join(root, 'entry.js'), 'changed');
  await prepareBot(root, options);
  await writeFile(join(root, 'resources/bot-runtime/bot.mjs'), 'corrupted');
  await prepareBot(root, options);
  assert.equal(builds, 3);
});

test('真实 pnpm run 为带空格路径完整传递构建参数，元数据留在开发缓存而非分发资源目录', async (t) => {
  const root = await fixture(t);
  await writeJson(join(root, 'package.json'), {
    name: 'fixture',
    scripts: { 'build:bot': 'node "fixture build.cjs"' },
  });
  await writeFile(join(root, 'entry.js'), 'source');
  await writeFile(
    join(root, 'fixture build.cjs'),
    `
const fs = require('node:fs');
const arg = process.argv[2];
require('node:assert/strict').equal(process.argv.length, 3);
require('node:assert/strict').equal(require('node:path').basename(arg), 'bot-meta.json');
require('node:assert/strict').equal(fs.realpathSync(require('node:path').dirname(arg.slice('--metafile='.length))), fs.realpathSync('.weq-dev'));
fs.mkdirSync('resources/bot-runtime', { recursive: true });
fs.writeFileSync('resources/bot-runtime/bot.mjs', 'fixture');
fs.writeFileSync(arg.slice('--metafile='.length), JSON.stringify({ inputs: { 'entry.js': {} } }));
`,
  );
  await prepareBot(root, { env: { ...process.env, npm_execpath: actualPnpm() }, log: silent });
  assert.equal(await exists(join(root, '.weq-dev/bot-build.json')), true);
  assert.equal(await exists(join(root, 'resources/bot-runtime/meta.json')), false);
});

test('开发锁拒绝同时启动并在失败后释放，可恢复已退出的已知进程锁', async (t) => {
  const root = await fixture(t);
  await withDevelopmentLock(root, async () => {
    await assert.rejects(
      withDevelopmentLock(root, async () => {}),
      /已在运行/,
    );
  });
  await assert.rejects(
    withDevelopmentLock(root, async () => {
      throw new Error('failed');
    }),
    /failed/,
  );
  assert.equal(await exists(join(root, '.weq-dev/running')), false);
  await writeJson(join(root, '.weq-dev/running/owner.json'), { pid: 2147483647 });
  await withDevelopmentLock(root, async () => {});
});

test('启动日志与应用共用行头，分块中文、CR 进度和长行均有界输出', () => {
  const now = Date.parse('2026-11-12T16:05:06Z');
  assert.equal(
    formatConsoleHeader('info', 'test', 'startup', { now, color: false }),
    '00:05:06 INFO  startup  test',
  );
  const lines = [];
  const output = commandOutput((...row) => lines.push(row), 'native');
  const bytes = Buffer.from('编译中\rwarning: actual warning\nerror[E000]: broken\n');
  output.write(bytes.subarray(0, 2));
  output.write(bytes.subarray(2));
  output.write(Buffer.from('x'.repeat(20_000)));
  output.end();
  assert.equal(lines[0][0], '编译中');
  assert.equal(lines[1][1], 'warn');
  assert.equal(lines[2][1], 'error');
  assert(lines.every(([line]) => line.length <= 16_384));
  assert.deepEqual(pnpmCommand(['install'], { npm_execpath: '/path with spaces/pnpm.cjs' }), [
    process.execPath,
    ['/path with spaces/pnpm.cjs', 'install'],
  ]);
});

test('命令执行保留失败退出码、缺失工具及参数，失败输出不被吞掉', async () => {
  const lines = [];
  const run = (code, args = []) =>
    runCommand(process.execPath, ['-e', code, ...args], { log: (...line) => lines.push(line) });
  await run('console.log(process.argv[1]);', ['a & b']);
  assert.equal(lines[0][0], 'a & b');
  await assert.rejects(
    run('console.error("error: fixture"); process.exitCode = 7;'),
    (error) => error.exitCode === 7,
  );
  assert(lines.some(([line, level]) => line === 'error: fixture' && level === 'error'));
  await assert.rejects(runCommand('/nonexistent/weq-tool', []), { code: 'ENOENT' });
  const module = new URL('./dev-process.mjs', import.meta.url).href;
  const childCode = 'console.log("00:05:06 INFO  app  ready\\n         at fixture")';
  const text = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {runCommand} from ${JSON.stringify(module)};
    await runCommand(process.execPath, ['-e', ${JSON.stringify(childCode)}]);
  `,
    ],
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
  );
  assert.equal(text, '00:05:06 INFO  app  ready\n         at fixture\n');
});

test('只终止本次启动的子进程组，SIGTERM 返回 143', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async (t) => {
  const root = await fixture(t);
  const pidFile = join(root, 'child.pid');
  const module = new URL('./dev-process.mjs', import.meta.url).href;
  const code = `import {runCommand} from ${JSON.stringify(module)}; try { await runCommand(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`)}]); } catch(e) { process.exitCode = e.exitCode ?? 1; }`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
  t.after(() => {
    if (parent.exitCode === null) parent.kill('SIGKILL');
  });
  const deadline = Date.now() + 5_000;
  while (!(await exists(pidFile))) {
    if (Date.now() > deadline) throw new Error('子进程未启动');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const exited = once(parent, 'exit');
  parent.kill('SIGTERM');
  const [status] = await exited;
  assert.equal(status, 143);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('全新目录里 pnpm dev 不依赖 node_modules 即能进入 bootstrap', async (t) => {
  const root = await fixture(t);
  await writeJson(join(root, 'package.json'), {
    name: 'fixture',
    scripts: { dev: 'node -e "console.log(\'bootstrap-ready\')"' },
  });
  const cli = actualPnpm();
  const [command, args] = pnpmCommand(['--dir', root, 'dev'], {
    ...process.env,
    npm_execpath: cli,
  });
  const result = execFileSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });
  assert(result.includes('bootstrap-ready'));
  assert.equal(await exists(join(root, 'node_modules')), false);
});
