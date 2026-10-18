import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveOzonePlatform } from '../src/main/linux_window_backend.ts';

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
