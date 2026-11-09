import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installTouchContextMenu } from '../src/renderer/src/lib/touchContextMenu';

let stop: () => void;
let target: HTMLElement;
function pointer(type: string, init: Partial<PointerEventInit> = {}, element = target) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 30,
    clientY: 40,
    ...init,
  });
  element.dispatchEvent(event);
  return event;
}
beforeEach(() => {
  vi.useFakeTimers();
  target = document.createElement('button');
  target.innerHTML = '<span>会话</span>';
  document.body.append(target);
  stop = installTouchContextMenu(document);
});
afterEach(() => {
  stop();
  document.body.replaceChildren();
  vi.useRealTimers();
});

it('任意位置的长按沿原始子节点冒泡为一次右键，松手不点击穿透菜单', () => {
  const menu = vi.fn((event: Event) => event.preventDefault());
  const click = vi.fn();
  target.addEventListener('contextmenu', menu);
  document.addEventListener('click', click);
  const child = target.firstElementChild as HTMLElement;
  pointer('pointerdown', {}, child);
  vi.advanceTimersByTime(459);
  expect(menu).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(menu).toHaveBeenCalledOnce();
  const event = menu.mock.calls[0]![0] as MouseEvent;
  expect([event.target, event.button, event.clientX, event.clientY]).toEqual([child, 2, 30, 40]);
  // 菜单焦点引起滚动或手指继续移动，不能提前解除松手防误点。
  target.dispatchEvent(new Event('scroll'));
  pointer('pointermove', { clientX: 60 });
  vi.advanceTimersByTime(1000);
  pointer('pointerup');
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(click).not.toHaveBeenCalled();
  pointer('pointerdown');
  pointer('pointerup');
  target.click();
  expect(click).toHaveBeenCalledOnce();
  document.removeEventListener('click', click);
});

it.each([
  'pointerup',
  'pointercancel',
  'lostpointercapture',
  'scroll',
  'blur',
  'move',
  'multi',
  'removed',
])('%s 取消长按，下一次手势仍能触发', (reason) => {
  const menu = vi.fn();
  target.addEventListener('contextmenu', menu);
  pointer('pointerdown');
  if (reason === 'move') pointer('pointermove', { clientX: 41 });
  else if (reason === 'multi') pointer('pointerdown', { pointerId: 2, isPrimary: false });
  else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
  else if (reason === 'removed') target.remove();
  else if (reason === 'scroll') target.dispatchEvent(new Event('scroll'));
  else pointer(reason);
  vi.advanceTimersByTime(500);
  expect(menu).not.toHaveBeenCalled();
  document.body.append(target);
  pointer('pointerdown');
  vi.advanceTimersByTime(500);
  expect(menu).toHaveBeenCalledOnce();
});

it('短按、鼠标、输入框和可编辑区域保留原交互', () => {
  const menu = vi.fn();
  document.body.addEventListener('contextmenu', menu);
  pointer('pointerdown', { pointerType: 'mouse' });
  vi.advanceTimersByTime(500);
  pointer('pointerdown');
  pointer('pointerup');
  vi.advanceTimersByTime(500);
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const editor = document.createElement(tag);
    if (tag === 'div') editor.setAttribute('contenteditable', 'true');
    document.body.append(editor);
    pointer('pointerdown', {}, editor);
    vi.advanceTimersByTime(500);
    expect(
      editor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    ).toBe(true);
  }
  expect(menu).toHaveBeenCalledTimes(4);
  document.body.removeEventListener('contextmenu', menu);
});

it('浏览器原生长按右键不会与统一识别重复触发，卸载会清理计时器和监听', () => {
  const menu = vi.fn();
  target.addEventListener('contextmenu', menu);
  pointer('pointerdown');
  const native = () =>
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(native()).toBe(false);
  vi.advanceTimersByTime(500);
  expect(menu).toHaveBeenCalledOnce();
  pointer('pointerup');
  expect(native()).toBe(false);
  expect(menu).toHaveBeenCalledOnce();
  pointer('pointerdown');
  stop();
  vi.advanceTimersByTime(500);
  expect(menu).toHaveBeenCalledOnce();
  expect(native()).toBe(true);
});
