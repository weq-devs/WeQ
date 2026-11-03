// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createStorageCleanupRestart,
  restartAfterStorageCleanup,
} from '../src/main/storage_cleanup_restart';
import { AUTOSTART_ARG, MANUAL_RESTART_ARG } from '../src/main/startup_window';

const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }));
afterEach(() => vi.unstubAllEnvs());

it.each([
  ['darwin', '/Applications/weQ.app/Contents/MacOS/weQ', '/Applications/weQ.app/Contents/MacOS'],
  ['win32', 'C:\\Program Files\\WeQ\\weQ.exe', 'C:\\Program Files\\WeQ'],
  ['linux', '/opt/weq/weQ', '/opt/weq'],
] as const)('%s 安装版直接启动原可执行文件，并恢复手动窗口身份', (platform, execPath, cwd) => {
  expect(
    createStorageCleanupRestart({
      platform,
      packaged: true,
      execPath,
      argv: [execPath, AUTOSTART_ARG, '--user-data-dir=profile'],
      appPath: '/unused',
    }),
  ).toEqual({ execPath, cwd, args: ['--user-data-dir=profile', MANUAL_RESTART_ARG] });
});

it('Linux AppImage 不从退出后已卸载的内部可执行文件启动', () => {
  expect(
    createStorageCleanupRestart({
      platform: 'linux',
      packaged: true,
      execPath: '/tmp/.mount_weq/usr/bin/weQ',
      appImage: '/home/user/Apps/weQ.AppImage',
      argv: ['/tmp/.mount_weq/usr/bin/weQ', '--ozone-platform=x11'],
      appPath: '/tmp/.mount_weq/resources/app.asar',
    }),
  ).toEqual({
    execPath: '/home/user/Apps/weQ.AppImage',
    cwd: '/home/user/Apps',
    args: ['--ozone-platform=x11', MANUAL_RESTART_ARG],
  });
});

it('开发版重启完整 electron-vite 工具链，不沿用旧渲染 URL', () => {
  const options = {
    platform: 'darwin' as const,
    packaged: false,
    execPath: '/deps/Electron',
    argv: ['/deps/Electron', '/repo/apps/desktop', AUTOSTART_ARG],
    appPath: '/repo/apps/desktop',
    rendererUrl: 'http://localhost:5173',
  };
  expect(() => createStorageCleanupRestart(options)).toThrow('Node 路径');
  expect(createStorageCleanupRestart({ ...options, nodePath: '/deps/node' })).toEqual({
    execPath: '/deps/node',
    cwd: '/repo/apps/desktop',
    args: [
      '/repo/apps/desktop/node_modules/electron-vite/bin/electron-vite.js',
      'dev',
      '--',
      MANUAL_RESTART_ARG,
    ],
  });
});

it('启动新进程时清除助手 Node 模式和旧开发环境', async () => {
  for (const name of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'ELECTRON_CLI_ARGS',
    'ELECTRON_ENTRY',
  ])
    vi.stubEnv(name, 'old-value');
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  fixture.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  const plan = { execPath: '/synthetic/weQ', args: [MANUAL_RESTART_ARG], cwd: '/synthetic' };
  await restartAfterStorageCleanup(plan);
  expect(fixture.spawn).toHaveBeenLastCalledWith(plan.execPath, plan.args, {
    cwd: plan.cwd,
    detached: true,
    stdio: 'ignore',
    env: expect.not.objectContaining({
      ELECTRON_RUN_AS_NODE: expect.anything(),
      ELECTRON_RENDERER_URL: expect.anything(),
      ELECTRON_CLI_ARGS: expect.anything(),
      ELECTRON_ENTRY: expect.anything(),
    }),
  });
  expect(child.unref).toHaveBeenCalledOnce();
});
