import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { useThemeStore } from '../src/renderer/src/state/theme';
import { buildPalette, mix as assistantMix } from '../src/main/weq_assistant/theme';
import {
  DEFAULT_DARK_ACCENT,
  accentColors,
  contrastRatio,
  mix,
  normalizeHex,
} from '../src/shared/theme_colors';

beforeEach(() => vi.stubGlobal('localStorage', new Storage()));

afterEach(() => {
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('主题可读色', () => {
  it('助手封面与跳转页复用同一混色和可读强调字，不改用户原色', () => {
    expect(assistantMix).toBe(mix);
    for (const mode of ['light', 'dark'] as const) {
      for (const accent of ['#ffffff', '#000000', '#fff3a1', '#075c30']) {
        const palette = buildPalette({ accent, mode });
        expect(palette.accent).toBe(accent);
        expect(palette.accentInk).toBe(accentColors(accent, mode).ink);
        expect(contrastRatio(palette.accentInk, palette.base)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('主题动画等待提交时，后续主色和背景修改不被旧快照覆盖', () => {
    const store = useThemeStore.getState();
    store.setPreference('light');
    store.setAccent('#075c30');
    let commit = () => {};
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    const original = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: (callback: () => void) => {
        commit = callback;
        return { finished: Promise.resolve() };
      },
    });
    try {
      store.setPreference('dark');
      store.setAccent('#fff3a1');
      store.setBackground('grid');
      commit();
      expect(document.documentElement.style.getPropertyValue('--weq-accent-custom')).toBe(
        '#fff3a1',
      );
      expect(document.documentElement.dataset.background).toBe('grid');
      expect(useThemeStore.getState().accent).toBe('#fff3a1');
      store.setPreference('light');
      const staleCommit = commit;
      store.setPreference('dark');
      staleCommit();
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(useThemeStore.getState().preference).toBe('dark');
      store.setPreference('light');
      const beforeRestore = commit;
      localStorage.setItem('weq.theme-preference', 'dark');
      localStorage.setItem('weq.theme-accent', '#000000');
      store.hydrate();
      beforeRestore();
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.documentElement.style.getPropertyValue('--weq-accent-custom')).toBe(
        '#000000',
      );
    } finally {
      if (original) Object.defineProperty(document, 'startViewTransition', original);
      else Reflect.deleteProperty(document, 'startViewTransition');
    }
  });
  it('对比度采用标准亮度而非 RGB 通道均值', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#777777')).toBeCloseTo(4.478, 3);
    expect(contrastRatio('#075c30', '#075c30')).toBe(1);
  });

  it('同一原色随深浅模式重新派生文字，不改用户选色', () => {
    const store = useThemeStore.getState();
    store.setPreference('light');
    store.setAccent('#075c30');
    const light = document.documentElement.style.getPropertyValue('--weq-accent-ink');
    store.setPreference('dark');
    expect(document.documentElement.style.getPropertyValue('--weq-accent-ink')).not.toBe(light);
    expect(useThemeStore.getState().accent).toBe('#075c30');
  });
  it.each(['#ffffff', '#000000', '#fff3a1', '#075c30', '#0099ff'])(
    '%s 有独立的实心文字和强调文字 token',
    (accent) => {
      const store = useThemeStore.getState();
      store.setPreference('light');
      store.setAccent(accent);
      expect(document.documentElement.style.getPropertyValue('--weq-accent-on')).toMatch(
        /^#[0-9a-f]{6}$/,
      );
      expect(document.documentElement.style.getPropertyValue('--weq-accent-ink')).toMatch(
        /^#[0-9a-f]{6}$/,
      );
      expect(document.documentElement.style.getPropertyValue('--weq-accent-custom')).toBe(accent);
    },
  );

  it('清除自定义色后，派生色与助手主题都恢复当前深浅的预设色', () => {
    const setTheme = vi.fn();
    vi.stubGlobal('weq', { weqAssistant: { setTheme } });
    const store = useThemeStore.getState();
    store.setPreference('dark');
    store.setAccent('#ffffff');
    store.setAccent('');
    expect(document.documentElement.style.getPropertyValue('--weq-accent-custom')).toBe('');
    expect(setTheme).toHaveBeenLastCalledWith({ accent: DEFAULT_DARK_ACCENT, mode: 'dark' });
    expect(document.documentElement.style.getPropertyValue('--weq-accent-on')).not.toBe('');
  });

  it('规范化沿用现有短Hex与空格约定', () => {
    expect(normalizeHex(' #AbC ')).toBe('#aabbcc');
    expect(normalizeHex('invalid')).toBeNull();
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('RGB 网格中每种原色的实心和强调文字均达到普通文字对比度', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (let r = 0; r <= 255; r += 51) {
        for (let g = 0; g <= 255; g += 51) {
          for (let b = 0; b <= 255; b += 51) {
            const input = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
            const colors = accentColors(input, mode);
            expect(colors.accent).toBe(input);
            expect(contrastRatio(input, colors.onAccent)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(colors.hover, colors.onAccent)).toBeGreaterThanOrEqual(4.5);
            const surface = mode === 'dark' ? '#363636' : '#f7f7f7';
            expect(contrastRatio(colors.ink, surface)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(colors.ink, mix(surface, input, 0.18))).toBeGreaterThanOrEqual(
              4.5,
            );
          }
        }
      }
    }
  });

  it('无效的持久化颜色不进入 CSS token 或助手桥', () => {
    localStorage.setItem('weq.theme-accent', 'not-a-color');
    useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().accent).toBe('');
    expect(document.documentElement.style.getPropertyValue('--weq-accent-custom')).toBe('');
  });
});
