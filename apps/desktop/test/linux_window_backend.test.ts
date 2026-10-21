import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  floatingWindowType,
  floatingWindowTypeOption,
  ozonePlatformArgs,
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

test('Linux windows advertise a floating window type, overridable per environment', () => {
  assert.equal(floatingWindowType('linux', {}), 'toolbar');
  assert.deepEqual(floatingWindowTypeOption('linux', {}), { type: 'toolbar' });
  assert.equal(floatingWindowType('linux', { WEQ_WINDOW_TYPE: 'normal' }), undefined);
  assert.deepEqual(floatingWindowTypeOption('linux', { WEQ_WINDOW_TYPE: 'normal' }), {});
  assert.equal(floatingWindowType('linux', { WEQ_WINDOW_TYPE: 'splash' }), 'splash');
  assert.equal(floatingWindowType('darwin', {}), undefined);
  assert.deepEqual(floatingWindowTypeOption('win32', {}), {});
});
