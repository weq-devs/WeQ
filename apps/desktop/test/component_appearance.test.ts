import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { componentStyles, useThemeStore } from '../src/renderer/src/state/theme';
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
  it('只展示简约和复古两套，不再堆叠相近的预设', () => {
    expect(componentStyles.map((style) => style.value)).toEqual(['minimal', 'retro']);
  });
  it('设置搜索可精确定位到风格与密度条目', () => {
    expect(resolveSettingsTarget({ section: 'appearance', item: '组件风格' }).settingId).toBe(
      'component-style',
    );
    expect(resolveSettingsTarget({ section: 'appearance', item: '界面密度' }).settingId).toBe(
      'interface-density',
    );
  });
  it.each(['minimal', 'retro'] as const)(
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
    store.setComponentStyle('retro');
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
    expect(useThemeStore.getState().componentStyle).toBe('retro');
  });

  it('收起的旧风格或未知值回落到简约，不改写其他有效偏好', () => {
    for (const invalid of [null, '', 'classic', 'soft', 'outline', 'glass', 'future-style']) {
      localStorage.clear();
      if (invalid !== null) {
        localStorage.setItem('weq.theme-component-style', invalid);
      }
      localStorage.setItem('weq.theme-density', 'compact');
      localStorage.setItem('weq.theme-accent', '#075c30');
      useThemeStore.getState().hydrate();
      expect(useThemeStore.getState().componentStyle).toBe('minimal');
      expect(useThemeStore.getState().density).toBe('compact');
      expect(useThemeStore.getState().accent).toBe('#075c30');
    }
  });
  it('缺失或未知密度仍采用舒适', () => {
    for (const value of ['', 'future-density']) {
      localStorage.setItem('weq.theme-density', value);
      useThemeStore.getState().hydrate();
      expect(useThemeStore.getState().density).toBe('comfortable');
      expect(document.documentElement.dataset.density).toBe('comfortable');
    }
  });
});
