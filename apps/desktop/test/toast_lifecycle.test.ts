import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';

let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useToast.setState({
    toasts: [],
    leaving: [],
    seq: 0,
    durations: { successSeconds: 3, failureSeconds: -1 },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(ToastHost)));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

describe('状态横幅的生命周期', () => {
  it('相同标识原地替换并清理旧详情和操作，不按相同标题合并不同错误', () => {
    const store = useToast.getState();
    const first = store.push({
      key: 'a',
      tone: 'error',
      title: '读取失败',
      detail: '已过期原因',
      action: { label: '旧操作', run: vi.fn() },
    });
    const other = store.push({ key: 'b', tone: 'error', title: '读取失败' });
    const ordinary = store.push({ tone: 'error', title: '读取失败' });
    expect(store.push({ key: 'a', tone: 'success', title: '读取成功' })).toBe(first);
    expect(useToast.getState().toasts.map((toast) => toast.id)).toEqual([first, other, ordinary]);
    expect(useToast.getState().toasts[0]).toMatchObject({
      title: '读取成功',
      tone: 'success',
      detail: undefined,
      action: undefined,
      ttl: 3000,
      timerRevision: 1,
    });
    expect(store.push({ title: '后续通知' })).toBe(ordinary + 1);
  });

  it('恢复时即使失败常驻且鼠标悬停也自动退场，其他错误继续保留', async () => {
    const host = mount();
    act(() => {
      useToast.getState().push({ key: 'a', tone: 'warning', title: '待提权' });
      useToast.getState().push({ key: 'b', tone: 'error', title: '其他错误' });
    });
    act(() =>
      host
        .querySelector('.weq-toast-warning')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(host.textContent).toContain('待提权');
    act(() => useToast.getState().resolve('a'));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(host.textContent).not.toContain('待提权');
    expect(host.textContent).toContain('其他错误');
    const state = useToast.getState();
    state.resolve('a');
    state.resolve('unknown');
    expect(useToast.getState()).toBe(state);
  });

  it('退场期间同一问题再次出现时取消旧退场，下一阶段从头计时', async () => {
    const host = mount();
    let id = 0;
    act(() => {
      id = useToast.getState().push({ key: 'a', tone: 'warning', title: '旧问题' });
    });
    const row = host.querySelector('.weq-toast');
    act(() => useToast.getState().resolve('a'));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    act(() => {
      expect(useToast.getState().push({ key: 'a', tone: 'success', title: '新阶段' })).toBe(id);
    });
    expect(host.querySelector('.weq-toast')).toBe(row);
    expect(useToast.getState().leaving).not.toContain(id);
    await act(async () => vi.advanceTimersByTimeAsync(2900));
    expect(host.textContent).toContain('新阶段');
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(host.querySelector('.weq-toast')).toBeNull();
  });
});
