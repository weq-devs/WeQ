import { afterEach, expect, it, vi } from 'vitest';
import { observeMobileWebViewport } from '../src/renderer/src/hooks/useMobileWebViewport';

afterEach(() => vi.unstubAllGlobals());

it('键盘只改变可视视口时同步高度和偏移，放大和无效尺寸不会重排', () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('matchMedia', () => media);
  const element = document.createElement('div');
  const stop = observeMobileWebViewport(element);
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('844px');
  viewport.height = 420;
  viewport.offsetTop = 30;
  viewport.dispatchEvent(new Event('resize'));
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('420px');
  expect(element.style.getPropertyValue('--weq-mobile-viewport-top')).toBe('30px');
  viewport.scale = 2;
  viewport.height = 210;
  viewport.dispatchEvent(new Event('resize'));
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('420px');
  viewport.scale = 1;
  viewport.height = 0;
  viewport.dispatchEvent(new Event('resize'));
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('420px');
  media.matches = false;
  media.dispatchEvent(new Event('change'));
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('');
  stop();
  media.matches = true;
  viewport.height = 844;
  viewport.dispatchEvent(new Event('resize'));
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('');
});

it('没有 VisualViewport 的浏览器回退窗口尺寸', () => {
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  const element = document.createElement('div');
  const stop = observeMobileWebViewport(element);
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe(`${innerHeight}px`);
  stop();
});
