import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  appImageRelaunchCommand,
  floatingWindowType,
  floatingWindowTypeOption,
  ozonePlatformArgs,
  ozoneRelaunchArgs,
  resolveOzonePlatform,
} from '../src/main/linux_window_backend.ts';

test('Wayland sessions use XWayland when an X display is available', () => {
  assert.equal(
    resolveOzonePlatform('linux', {
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-1',
      DISPLAY: ':0',
    }),
    'x11',
  );
});

test('native Wayland is kept when no XWayland display is available', () => {
  assert.equal(
    resolveOzonePlatform('linux', {
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-1',
    }),
    null,
  );
});

test('non-Wayland Linux and non-Linux platforms are left untouched', () => {
  assert.equal(resolveOzonePlatform('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), null);
  assert.equal(
    resolveOzonePlatform('darwin', { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }),
    null,
  );
});

test('WEQ_OZONE_PLATFORM can opt into native Wayland or force XWayland', () => {
  const wayland = {
    XDG_SESSION_TYPE: 'wayland',
    WAYLAND_DISPLAY: 'wayland-1',
    DISPLAY: ':0',
    WEQ_OZONE_PLATFORM: 'wayland',
  };
  assert.equal(resolveOzonePlatform('linux', wayland), null);
  assert.equal(
    resolveOzonePlatform('linux', {
      XDG_SESSION_TYPE: 'x11',
      DISPLAY: ':0',
      WEQ_OZONE_PLATFORM: 'x11',
    }),
    'x11',
  );
});

test('ozonePlatformArgs turns the resolved backend into an Electron CLI flag', () => {
  // 必须在启动参数里，不能靠 app.commandLine.appendSwitch：见 linux_window_backend.ts。
  assert.deepEqual(
    ozonePlatformArgs('linux', {
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-1',
      DISPLAY: ':0',
    }),
    ['--ozone-platform=x11'],
  );
  assert.deepEqual(ozonePlatformArgs('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), []);
  assert.deepEqual(
    ozonePlatformArgs('linux', {
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-1',
      DISPLAY: ':0',
      WEQ_OZONE_PLATFORM: 'wayland',
    }),
    [],
  );
  assert.deepEqual(ozonePlatformArgs('darwin', {}), []);
});

// 回归：打包产物只有从 .desktop 启动才带得上 ozone 参数（electron-builder 只把它
// 写进 AppImage 的桌面文件），tar.gz 解压直跑 / 直接执行 AppImage 都得靠这次重启。
const waylandWithX = {
  XDG_SESSION_TYPE: 'wayland',
  WAYLAND_DISPLAY: 'wayland-1',
  DISPLAY: ':0',
};

test('packaged builds relaunch once when the ozone flag never made it to argv', () => {
  assert.deepEqual(ozoneRelaunchArgs(['/opt/weQ/weQ'], 'linux', waylandWithX), {
    args: ['--ozone-platform=x11'],
  });
  // AppImage：execPath 必须指回真实文件，并补上 --no-sandbox（FUSE 上 setuid 无效）。
  assert.deepEqual(
    ozoneRelaunchArgs(['/tmp/.mount_weQ123/weQ'], 'linux', {
      ...waylandWithX,
      APPIMAGE: '/home/u/weQ-2.1.0-linux-x86_64.AppImage',
    }),
    {
      execPath: '/home/u/weQ-2.1.0-linux-x86_64.AppImage',
      args: ['--ozone-platform=x11', '--no-sandbox'],
    },
  );
});

test('default AppImage relaunch reads APPIMAGE from the process environment', () => {
  const previous = {
    APPIMAGE: process.env.APPIMAGE,
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    WEQ_OZONE_PLATFORM: process.env.WEQ_OZONE_PLATFORM,
    WEQ_OZONE_RELAUNCHED: process.env.WEQ_OZONE_RELAUNCHED,
  };
  process.env.APPIMAGE = '/home/u/weQ-2.6.0-linux-x86_64.AppImage';
  process.env.DISPLAY = ':0';
  process.env.WAYLAND_DISPLAY = 'wayland-1';
  process.env.XDG_SESSION_TYPE = 'wayland';
  delete process.env.WEQ_OZONE_PLATFORM;
  delete process.env.WEQ_OZONE_RELAUNCHED;

  try {
    assert.deepEqual(ozoneRelaunchArgs(['/tmp/.mount_weQ123/@weqdesktop'], 'linux'), {
      execPath: process.env.APPIMAGE,
      args: ['--ozone-platform=x11', '--no-sandbox'],
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('AppImage relaunch waits for the old mount owner to exit', () => {
  const command = appImageRelaunchCommand(
    '/home/u/weQ-2.6.0-linux-x86_64.AppImage',
    ['--ozone-platform=x11', '--no-sandbox'],
    1234,
    '/tmp/.mount_weQ-old',
  );

  assert.equal(command.execPath, '/bin/sh');
  assert.equal(command.args[0], '-c');
  assert.match(command.args[1], /kill -0/);
  assert.match(command.args[1], /unset APPIMAGE APPDIR/);
  assert.match(command.args[1], /sleep 1/);
  assert.deepEqual(command.args.slice(2), [
    'weq-ozone-relaunch',
    '1234',
    '/tmp/.mount_weQ-old',
    '/home/u/weQ-2.6.0-linux-x86_64.AppImage',
    '--ozone-platform=x11',
    '--no-sandbox',
  ]);
});

test('no relaunch when the flag is already present, or on non-Linux', () => {
  // dev：electron.vite.config.ts 注入，argv 里已经有了。
  assert.equal(
    ozoneRelaunchArgs(['electron', '.', '--ozone-platform=x11'], 'linux', waylandWithX),
    null,
  );
  // 菜单启动：.desktop 的 Exec 带上了（分开写与 = 写法都要认）。
  assert.equal(ozoneRelaunchArgs(['weQ', '--ozone-platform', 'x11'], 'linux', waylandWithX), null);
  assert.equal(ozoneRelaunchArgs(['weQ'], 'darwin', waylandWithX), null);
});

test('no relaunch when the backend should stay native Wayland', () => {
  // 纯 Wayland 桌面没有 DISPLAY：保持原生，不能硬塞 x11。
  assert.equal(
    ozoneRelaunchArgs(['weQ'], 'linux', {
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-1',
    }),
    null,
  );
  // X11 桌面上不需要。
  assert.equal(
    ozoneRelaunchArgs(['weQ'], 'linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }),
    null,
  );
  // WEQ_OZONE_PLATFORM=wayland 显式退回原生。
  assert.equal(
    ozoneRelaunchArgs(['weQ'], 'linux', { ...waylandWithX, WEQ_OZONE_PLATFORM: 'wayland' }),
    null,
  );
});

test('relaunch guard prevents an infinite relaunch loop', () => {
  assert.equal(
    ozoneRelaunchArgs(['weQ'], 'linux', { ...waylandWithX, WEQ_OZONE_RELAUNCHED: '1' }),
    null,
  );
});

test('Linux windows advertise a floating window type, overridable per environment', () => {
  assert.equal(floatingWindowType('linux', {}), 'toolbar');
  assert.deepEqual(floatingWindowTypeOption('linux', {}), { type: 'toolbar' });
  assert.equal(floatingWindowType('linux', { WEQ_WINDOW_TYPE: 'normal' }), undefined);
  assert.deepEqual(floatingWindowTypeOption('linux', { WEQ_WINDOW_TYPE: 'normal' }), {});
  assert.equal(floatingWindowType('linux', { WEQ_WINDOW_TYPE: 'splash' }), 'splash');
  assert.equal(floatingWindowType('darwin', {}), undefined);
  assert.deepEqual(floatingWindowTypeOption('win32', {}), {});
});
