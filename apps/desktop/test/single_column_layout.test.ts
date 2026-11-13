import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMobileWebLayout } from '../src/renderer/src/hooks/useMobileWebViewport';
import { isMobileNavigation } from '../src/renderer/src/hooks/useMobileNavigation';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.unstubAllGlobals());

it('桌面窗口收窄和拉宽时切换 Remote 共用的单栏布局', async () => {
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => media);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture() {
    return createElement('div', { 'data-single-column': useMobileWebLayout() });
  }
  try {
    await act(async () => root.render(createElement(Fixture)));
    expect(host.firstElementChild?.getAttribute('data-single-column')).toBe('false');
    await act(async () => {
      media.matches = true;
      media.dispatchEvent(new Event('change'));
    });
    expect(host.firstElementChild?.getAttribute('data-single-column')).toBe('true');
    await act(async () => {
      media.matches = false;
      media.dispatchEvent(new Event('change'));
    });
    expect(host.firstElementChild?.getAttribute('data-single-column')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('桌面窄窗使用共用返回导航，拉宽后不接管桌面导航', () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal('matchMedia', () => media);
  expect(isMobileNavigation()).toBe(true);
  media.matches = false;
  expect(isMobileNavigation()).toBe(false);
});
