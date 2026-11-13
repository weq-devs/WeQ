import { afterEach, expect, it, vi } from 'vitest';
import {
  isSingleColumnLayout,
  resolveResponsiveLayout,
  subscribeResponsiveLayout,
} from '../src/renderer/src/lib/responsiveLayout';

vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('未提供 matchMedia 的宿主也可导入布局模块并按实际宽度回退', async () => {
  vi.stubGlobal('matchMedia', undefined);
  vi.resetModules();
  const layout = await import('../src/renderer/src/lib/responsiveLayout');
  expect(typeof layout.isSingleColumnLayout()).toBe('boolean');
});

it.each([
  [600, 900, false, 'single'],
  [600, 320, false, 'single'],
  [760, 1000, false, 'single'],
  [800, 1200, false, 'wide'],
  [390, 844, true, 'single'],
  [640, 320, true, 'wide'],
  [760, 430, true, 'wide'],
  [844, 390, true, 'wide'],
  [1024, 768, true, 'wide'],
] as const)(
  '布局按客户端与实际可用宽度决策：%s × %s / 移动端 %s',
  (width, height, mobileClient, expected) => {
    expect(resolveResponsiveLayout({ width, height, mobileClient })).toBe(expected);
  },
);

it('软键盘缩短布局视口时以设备方向为准，不把竖屏误切为多栏', () => {
  expect(
    resolveResponsiveLayout({ width: 430, height: 320, mobileClient: true, landscape: false }),
  ).toBe('single');
  expect(
    resolveResponsiveLayout({ width: 640, height: 900, mobileClient: true, landscape: true }),
  ).toBe('wide');
});

it('Remote方向变化统一更新样式和订阅，键盘缩短窗口不改变竖屏布局', () => {
  const orientation = Object.assign(new EventTarget(), { type: 'portrait-primary' });
  vi.stubGlobal('screen', { orientation });
  vi.stubGlobal('innerWidth', 430);
  vi.stubGlobal('innerHeight', 932);
  vi.stubGlobal('weqRemoteShell', { openMenu() {} });
  vi.stubGlobal('matchMedia', (query: string) =>
    Object.assign(new EventTarget(), {
      matches: query === '(max-width: 760px)' ? innerWidth <= 760 : true,
    }),
  );
  const notify = vi.fn();
  const stop = subscribeResponsiveLayout(notify);
  try {
    expect(isSingleColumnLayout()).toBe(true);
    expect(document.documentElement.dataset.weqLayout).toBe('single');
    vi.stubGlobal('innerHeight', 320);
    window.dispatchEvent(new Event('resize'));
    expect(isSingleColumnLayout()).toBe(true);
    orientation.type = 'landscape-primary';
    vi.stubGlobal('innerWidth', 640);
    orientation.dispatchEvent(new Event('change'));
    expect(isSingleColumnLayout()).toBe(false);
    expect(document.documentElement.dataset.weqLayout).toBe('wide');
    expect(document.documentElement.dataset.weqInput).toBe('touch');
    expect(notify).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

it.each([
  ['Mozilla/5.0 (Windows NT 10.0)', 5, true],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X)', 0, true],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X)', 5, false],
  ['Mozilla/5.0 (Linux; Android 15)', 5, false],
] as const)('桌面与触控客户端不靠宽度混淆：%s / 触点%s', (userAgent, maxTouchPoints, single) => {
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
  vi.stubGlobal('screen', { orientation: { type: 'landscape-primary' } });
  vi.stubGlobal('innerWidth', 640);
  vi.stubGlobal('innerHeight', 320);
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  expect(isSingleColumnLayout()).toBe(single);
});
