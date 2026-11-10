// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { setInputModality } from '../src/renderer/src/lib/inputModality';

const modality = () => document.documentElement.dataset.weqInputModality;
const key = (key: string, shiftKey = false) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));

afterEach(() => setInputModality('pointer'));

it('Esc 和 Enter 不把鼠标操作切成键盘导航，Tab 才点亮焦点提示', () => {
  setInputModality('pointer');
  key('Escape');
  key('Enter');
  expect(modality()).toBe('pointer');
  key('Tab');
  expect(modality()).toBe('keyboard');
  key('Enter');
  key('Escape');
  expect(modality()).toBe('keyboard');
});

it('Shift+Tab 同样启用键盘提示，下次指针操作恢复无外圈状态', () => {
  setInputModality('pointer');
  key('Tab', true);
  expect(modality()).toBe('keyboard');
  document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  expect(modality()).toBe('pointer');
});
