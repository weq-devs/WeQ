import { afterEach, expect, it, vi } from 'vitest';
import { observeMobileWebViewport } from '../src/renderer/src/hooks/useMobileWebViewport';

afterEach(() => vi.unstubAllGlobals());

it('返回列表时不沿用键盘退出前的小视口和偏移，重新编辑后仍正确适配键盘', () => {
  const viewport = Object.assign(new EventTarget(), { height: 320, offsetTop: 96, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  const element = document.createElement('div');
  element.className = 'app-shell-root';
  const editor = document.createElement('textarea');
  element.append(editor);
  document.body.append(element);
  editor.focus();
  const stop = observeMobileWebViewport(element);
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('320px');
  editor.blur();
  window.dispatchEvent(new CustomEvent('weq-mobile-navigate', { detail: 'back' }));
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('844px');
  expect(element.style.getPropertyValue('--weq-mobile-viewport-top')).toBe('0px');
  editor.focus();
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('320px');
  stop();
  element.remove();
});

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
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('420px');
  stop();
  media.matches = true;
  viewport.height = 844;
  viewport.dispatchEvent(new Event('resize'));
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('');
});

it('横屏多栏仍跟随键盘可视视口，不依赖单栏宽度查询', () => {
  const viewport = Object.assign(new EventTarget(), { height: 390, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerWidth', 844);
  vi.stubGlobal('innerHeight', 390);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
  const element = document.createElement('div');
  const stop = observeMobileWebViewport(element);
  try {
    expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('390px');
    viewport.height = 210;
    viewport.offsetTop = 18;
    viewport.dispatchEvent(new Event('resize'));
    expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('210px');
    expect(element.style.getPropertyValue('--weq-mobile-viewport-top')).toBe('18px');
  } finally {
    stop();
  }
});

it('没有 VisualViewport 的浏览器回退窗口尺寸', () => {
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  const element = document.createElement('div');
  const stop = observeMobileWebViewport(element);
  expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe(`${innerHeight}px`);
  stop();
});

it.each([false, true])('键盘只占用一次底部空间（布局视口同步缩小：%s）', (resizeLayout) => {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  const element = document.createElement('div');
  const editor = document.createElement('textarea');
  element.append(editor);
  document.body.append(element);
  const stop = observeMobileWebViewport(element);
  try {
    expect(element.style.getPropertyValue('--weq-mobile-safe-bottom')).toBe('');
    editor.focus();
    // 外接键盘聚焦、浏览器地址栏的小幅伸缩都不应抹掉 Home Indicator 安全区。
    viewport.height = 800;
    viewport.dispatchEvent(new Event('resize'));
    expect(element.style.getPropertyValue('--weq-mobile-safe-bottom')).toBe('');
    viewport.height = 430;
    if (resizeLayout) vi.stubGlobal('innerHeight', 430);
    viewport.dispatchEvent(new Event('resize'));
    expect(element.style.getPropertyValue('--weq-mobile-safe-bottom')).toBe('0px');
    expect(element.style.getPropertyValue('--weq-mobile-viewport-height')).toBe('430px');
    // 切换到表情按钮时，键盘尚未退出，不能先恢复安全区导致跳动。
    editor.blur();
    viewport.dispatchEvent(new Event('scroll'));
    expect(element.style.getPropertyValue('--weq-mobile-safe-bottom')).toBe('0px');
    viewport.height = 844;
    vi.stubGlobal('innerHeight', 844);
    viewport.dispatchEvent(new Event('resize'));
    expect(element.style.getPropertyValue('--weq-mobile-safe-bottom')).toBe('');
  } finally {
    stop();
    expect(element.style.getPropertyValue('--weq-mobile-safe-bottom')).toBe('');
    element.remove();
  }
});
