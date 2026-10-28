import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { useThemeStore } from '../src/renderer/src/state/theme';
import { resolveSettingsTarget } from '../src/renderer/src/components/settings/navigation';

beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  useThemeStore.getState().hydrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('组件风格与独立密度', () => {
  it('设置搜索可精确定位到风格与密度条目', () => {
    expect(resolveSettingsTarget({ section: 'appearance', item: '组件风格' }).settingId).toBe(
      'component-style',
    );
    expect(resolveSettingsTarget({ section: 'appearance', item: '界面密度' }).settingId).toBe(
      'interface-density',
    );
  });
  it.each(['classic', 'minimal', 'soft', 'outline', 'glass', 'retro'] as const)(
    '%s 应用到根节点并可从存储恢复，不改主题色或背景',
    (style) => {
      const store = useThemeStore.getState();
      store.setAccent('#075c30');
      store.setBackground('telegram');
      store.setDensity('compact');
      store.setComponentStyle(style);
      expect(document.documentElement.dataset.componentStyle).toBe(style);
      expect(localStorage.getItem('weq.theme-component-style')).toBe(style);
      store.hydrate();
      expect(useThemeStore.getState()).toMatchObject({
        componentStyle: style,
        density: 'compact',
        accent: '#075c30',
        background: 'telegram',
      });
    },
  );

  it('密度独立保存，其他外观操作和跟随系统刷新不会重置它', () => {
    const store = useThemeStore.getState();
    store.setComponentStyle('soft');
    store.setDensity('compact');
    store.setAccent('#fff3a1');
    store.setBackground('grid');
    store.setPreference('system');
    store.syncResolved();
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(localStorage.getItem('weq.theme-density')).toBe('compact');
    store.hydrate();
    expect(useThemeStore.getState().density).toBe('compact');
    store.setDensity('comfortable');
    expect(document.documentElement.dataset.density).toBe('comfortable');
    expect(useThemeStore.getState().componentStyle).toBe('soft');
  });

  it('旧配置或未知值回落到经典和舒适，不影响有效外观配置', () => {
    for (const invalid of [null, '', 'future-style']) {
      localStorage.clear();
      if (invalid !== null) {
        localStorage.setItem('weq.theme-component-style', invalid);
        localStorage.setItem('weq.theme-density', invalid);
      }
      useThemeStore.getState().hydrate();
      expect(useThemeStore.getState().componentStyle).toBe('classic');
      expect(useThemeStore.getState().density).toBe('comfortable');
      expect(document.documentElement.dataset.density).toBe('comfortable');
    }
  });
});
