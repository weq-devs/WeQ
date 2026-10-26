// @vitest-environment node
import { EventEmitter } from 'node:events';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareDevelopmentRestart } from '../src/main/development_restart';
import { MANUAL_RESTART_ARG } from '../src/main/startup_window';
import desktopPackage from '../package.json';

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

function message(child: ChildProcess) {
  return new Promise<{ type: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('助手未回复')), 5000);
    child.once('message', (value) => {
      clearTimeout(timer);
      resolve(value as { type: string });
    });
  });
}

it('真实助手等旧进程退出后才启动开发 CLI，清除过期页面地址并保留用户参数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-restart-test-'));
  directories.push(dir);
  const output = join(dir, 'launched.json');
  const cli = join(dir, 'fake-cli.cjs');
  await writeFile(
    cli,
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ argv: process.argv.slice(2), url: process.env.ELECTRON_RENDERER_URL, node: process.env.ELECTRON_RUN_AS_NODE, entry: process.env.ELECTRON_ENTRY, native: process.env.WEQ_NATIVE_DIR }));`,
  );
  // 独立等待进程作为旧应用，明确验证仍存活时不能拉起新 CLI。
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(old);
  await new Promise((resolve) => old.once('spawn', resolve));
  const helper = fork(
    resolve('../../scripts/restart-desktop-dev.mjs'),
    [
      JSON.stringify({
        parentPid: old.pid,
        appPath: dir,
        cli,
        args: ['--user-data-dir=fixture', MANUAL_RESTART_ARG],
        logPath: join(dir, 'restart.log'),
      }),
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: 'http://127.0.0.1:1',
        ELECTRON_ENTRY: 'old',
        ELECTRON_CLI_ARGS: '["old"]',
        WEQ_NATIVE_DIR: '/fixture/native',
      },
    },
  );
  children.push(helper);
  expect(await message(helper)).toEqual({ type: 'ready' });
  const committed = message(helper);
  helper.send({ type: 'commit' });
  expect(await committed).toEqual({ type: 'committed' });
  helper.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  const exited = new Promise((resolve) => old.once('exit', resolve));
  old.kill();
  await exited;
  await vi.waitFor(async () => {
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
      argv: ['dev', '--', '--user-data-dir=fixture', MANUAL_RESTART_ARG],
      native: '/fixture/native',
    });
  });
});

it('重启入口实际重建 Vite 页面服务，不依赖已退出的旧地址或真实 Electron 窗口', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-restart-vite-'));
  directories.push(dir);
  const output = join(dir, 'page.json');
  await mkdir(join(dir, 'renderer'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'weq-restart-fixture',
      type: 'module',
      main: './out/main/index.js',
      devDependencies: { electron: desktopPackage.devDependencies.electron },
    }),
  );
  await writeFile(
    join(dir, 'renderer/index.html'),
    '<html><body>restart-page-fixture</body></html>',
  );
  await writeFile(
    join(dir, 'main.js'),
    `import { writeFileSync } from 'node:fs'; const url = process.env.ELECTRON_RENDERER_URL; const html = await (await fetch(url, {signal: AbortSignal.timeout(10000)})).text(); writeFileSync(${JSON.stringify(output)}, JSON.stringify({url, html}));`,
  );
  await writeFile(
    join(dir, 'electron.vite.config.mjs'),
    `export default { main: {build: {rollupOptions: {input: {index: ${JSON.stringify(join(dir, 'main.js'))}}}}}, renderer: {root: ${JSON.stringify(join(dir, 'renderer'))}, build: {rollupOptions: {input: ${JSON.stringify(join(dir, 'renderer/index.html'))}}}, server: {host: '127.0.0.1', port: 0}} };`,
  );
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(old);
  await new Promise((resolve) => old.once('spawn', resolve));
  const helper = fork(
    resolve('../../scripts/restart-desktop-dev.mjs'),
    [
      JSON.stringify({
        parentPid: old.pid,
        appPath: dir,
        cli: resolve('node_modules/electron-vite/bin/electron-vite.js'),
        args: [],
        logPath: join(dir, 'restart.log'),
      }),
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_EXEC_PATH: process.execPath,
        ELECTRON_RENDERER_URL: 'http://127.0.0.1:1',
        ELECTRON_ENTRY: '/missing',
      },
    },
  );
  children.push(helper);
  expect(await message(helper)).toEqual({ type: 'ready' });
  const committed = message(helper);
  helper.send({ type: 'commit' });
  await committed;
  helper.disconnect();
  const exited = new Promise((resolve) => old.once('exit', resolve));
  old.kill();
  await exited;
  await vi
    .waitFor(
      async () => {
        const result = JSON.parse(await readFile(output, 'utf8'));
        expect(result.url).not.toBe('http://127.0.0.1:1');
        expect(result.html).toContain('restart-page-fixture');
      },
      { timeout: 20000 },
    )
    .catch(async (error) => {
      throw new Error(await readFile(join(dir, 'restart.log'), 'utf8'), { cause: error });
    });
}, 25000);

it('缺失开发工具链时准备失败，不退出应用', async () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  await expect(
    prepareDevelopmentRestart(app, {
      appPath: '/synthetic/missing',
      argv: ['electron', '.'],
      logPath: '/synthetic/log',
    }),
  ).rejects.toThrow('Node 路径');
  expect(app.quit).not.toHaveBeenCalled();
  expect(app.listenerCount('will-quit')).toBe(0);
});
