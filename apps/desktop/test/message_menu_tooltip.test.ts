import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HoverTooltip } from '../src/renderer/src/components/HoverTooltip';
import { installTouchContextMenu } from '../src/renderer/src/lib/touchContextMenu';

let host: HTMLDivElement, menu: HTMLDivElement, button: HTMLButtonElement;
let root: ReturnType<typeof createRoot>, stop: () => void;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  host = document.createElement('div');
  menu = document.createElement('div');
  menu.dataset.hoverDelay = '0';
  button = document.createElement('button');
  button.title = '导出';
  menu.append(button);
  document.body.append(host, menu);
  root = createRoot(host);
  stop = installTouchContextMenu(document);
  act(() => root.render(createElement(HoverTooltip)));
});
afterEach(() => {
  act(() => root.unmount());
  stop();
  host.remove();
  menu.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const pointer = (type: string, extra: Partial<PointerEventInit> = {}) =>
  act(() =>
    button.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        isPrimary: true,
        pointerId: 1,
        clientX: 20,
        clientY: 20,
        ...extra,
      }),
    ),
  );

it('菜单悬停无需推进时间即可显示，禁用按钮也能显示原因，其他界面仍等待 250ms', () => {
  button.disabled = true;
  button.title = '正在导出';
  pointer('pointerover', { pointerType: 'mouse' });
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('正在导出');
  pointer('pointerout', { pointerType: 'mouse' });
  delete menu.dataset.hoverDelay;
  pointer('pointerover', { pointerType: 'mouse' });
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  act(() => vi.advanceTimersByTime(250));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('正在导出');
});

it('菜单图标长按只显示提示，松手不点击，不重新触发右键；下一次短按可执行', () => {
  const click = vi.fn(),
    context = vi.fn();
  button.addEventListener('click', click);
  menu.addEventListener('contextmenu', context);
  pointer('pointerdown');
  act(() => vi.advanceTimersByTime(460));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('导出');
  expect(context).not.toHaveBeenCalled();
  pointer('pointerup');
  act(() => button.click());
  expect(click).not.toHaveBeenCalled();
  pointer('pointerdown');
  pointer('pointerup');
  act(() => button.click());
  expect(click).toHaveBeenCalledOnce();
});

it('长按前移动会取消提示，不把正常短按误判为长按', () => {
  pointer('pointerdown');
  pointer('pointermove', { clientX: 60 });
  act(() => vi.advanceTimersByTime(500));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
