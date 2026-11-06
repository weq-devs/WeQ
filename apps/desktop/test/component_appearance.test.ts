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
  it('默认采用纯净背景与首位的 QQ NT 风格，并保留其他预设', () => {
    expect(componentStyles.map((style) => style.value)).toEqual([
      'qqnt',
      'classic',
      'minimal',
      'retro',
    ]);
    expect(useThemeStore.getState().componentStyle).toBe('qqnt');
    expect(useThemeStore.getState().background).toBe('plain');
    expect(document.documentElement.dataset.componentStyle).toBe('qqnt');
    expect(document.documentElement.dataset.background).toBe('plain');
  });
  it('设置搜索可精确定位到风格与密度条目', () => {
    expect(resolveSettingsTarget({ section: 'appearance', item: '组件风格' }).settingId).toBe(
      'component-style',
    );
    expect(resolveSettingsTarget({ section: 'appearance', item: '界面密度' }).settingId).toBe(
      'interface-density',
    );
  });
  it.each(componentStyles.map((style) => style.value))(
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

  it('缺失配置、收起的旧风格或未知值回落到 QQ NT，不改写其他有效偏好', () => {
    for (const invalid of [null, '', 'soft', 'outline', 'glass', 'future-style']) {
      localStorage.clear();
      if (invalid !== null) {
        localStorage.setItem('weq.theme-component-style', invalid);
      }
      localStorage.setItem('weq.theme-density', 'compact');
      localStorage.setItem('weq.theme-accent', '#075c30');
      useThemeStore.getState().hydrate();
      expect(useThemeStore.getState().componentStyle).toBe('qqnt');
      expect(useThemeStore.getState().density).toBe('compact');
      expect(useThemeStore.getState().accent).toBe('#075c30');
    }
  });
  it('未知背景回落到纯净，已保存的背景保持不变', () => {
    localStorage.setItem('weq.theme-background', 'future-background');
    useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().background).toBe('plain');
    localStorage.setItem('weq.theme-background', 'paper');
    useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().background).toBe('paper');
  });
  it('存储不可读时仍采用纯净背景与 QQ NT 风格', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('存储不可读');
    });
    useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({
      background: 'plain',
      componentStyle: 'qqnt',
    });
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
