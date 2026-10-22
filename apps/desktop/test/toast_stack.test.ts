import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';

let root: Root;
let host: HTMLDivElement;
let contentHeight: number;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  contentHeight = 600;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
    return this.classList.contains('weq-toast-host') ? contentHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
  useToast.setState({ toasts: [], leaving: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(ToastHost)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useToast.setState({ toasts: [], leaving: [] });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function push(title: string) {
  act(() => {
    useToast.getState().push({ title, detail: '合成详情', durationKind: 'long', ttl: 0 });
  });
}
function stack() {
  return host.querySelector<HTMLElement>('.weq-toast-host')!;
}
function scroll(top: number) {
  act(() => {
    stack().scrollTop = top;
    stack().dispatchEvent(new Event('scroll'));
  });
}

describe('有界通知队列的阅读位置', () => {
  it('默认跟随新通知，不删除旧通知，也不重挂已经展开的内容', () => {
    push('第一条');
    const first = stack().querySelector('.weq-toast')!;
    act(() => first.querySelector<HTMLButtonElement>('[aria-label="展开详情"]')!.click());
    expect(stack().scrollTop).toBe(contentHeight);
    contentHeight = 900;
    push('第二条');
    expect(stack().scrollTop).toBe(contentHeight);
    expect(stack().querySelectorAll('.weq-toast')).toHaveLength(2);
    expect(stack().querySelector('.weq-toast')).toBe(first);
    expect(first.classList.contains('expanded')).toBe(true);
    expect(useToast.getState().toasts.every((toast) => toast.ttl === 0)).toBe(true);
  });

  it('用户上翻时保留阅读位置，回到末尾后恢复跟随', () => {
    push('第一条');
    scroll(100);
    contentHeight = 900;
    push('第二条');
    expect(stack().scrollTop).toBe(100);
    scroll(contentHeight - 200);
    contentHeight = 1200;
    push('第三条');
    expect(stack().scrollTop).toBe(contentHeight);
  });

  it('全部关闭再出现的新队列重新默认跟随', () => {
    push('旧队列');
    scroll(100);
    act(() => useToast.setState({ toasts: [] }));
    expect(host.querySelector('.weq-toast-host')).toBeNull();
    contentHeight = 400;
    push('新队列');
    expect(stack().scrollTop).toBe(contentHeight);
  });

  it('正在滚动详情时不因新通知跳走，正文和原展开状态保留', () => {
    push('详情阅读');
    const first = stack().querySelector('.weq-toast')!;
    act(() => first.querySelector<HTMLButtonElement>('[aria-label="展开详情"]')!.click());
    const detail = first.querySelector<HTMLElement>('.weq-toast-detail')!;
    act(() => detail.dispatchEvent(new Event('scroll')));
    stack().scrollTop = 400;
    contentHeight = 900;
    push('新通知');
    expect(stack().scrollTop).toBe(400);
    expect(first.classList.contains('expanded')).toBe(true);
    expect(detail.textContent).toBe('合成详情');
  });
});
