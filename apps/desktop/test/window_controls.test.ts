// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { supportsWindowsStyleControls, windowControlsStyle } from '../src/shared/window_controls';
import {
  windowDecorationOptions,
  registerWindowControlsPreference,
} from '../src/main/window_controls_events';
import { applicationToolPopupOptions } from '../src/main/tool_window';

afterEach(() => {
  registerWindowControlsPreference(() => false);
  vi.restoreAllMocks();
});

it.each(['darwin', 'linux', 'win32'])(
  '%s 的账号选择始终统一，主界面只在支持平台使用偏好',
  (platform) => {
    for (const enabled of [false, true]) {
      expect(windowControlsStyle(platform, enabled, 'home')).toBe('windows');
      expect(windowControlsStyle(platform, enabled, 'chat')).toBe(
        platform === 'win32' || enabled ? 'windows' : 'native',
      );
    }
    expect(supportsWindowsStyleControls(platform)).toBe(platform !== 'win32');
  },
);

it.each(['darwin', 'linux', 'win32'] as const)(
  '%s 的各类工具窗按偏好决定边框，不增加特权',
  (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    for (const enabled of [false, true]) {
      registerWindowControlsPreference(() => enabled);
      const custom = platform !== 'win32' && enabled;
      expect(windowDecorationOptions()).toEqual(custom ? { frame: false } : {});
      for (const name of ['weq-call', 'weq-capture', 'weq-db-repair', 'weq-compose']) {
        const options = applicationToolPopupOptions('about:blank', name)!;
        expect(options.frame).toBe(
          name === 'weq-compose' && platform === 'win32' ? false : !custom,
        );
        expect(options.webPreferences).toMatchObject({
          preload: undefined,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        });
      }
    }
  },
);
