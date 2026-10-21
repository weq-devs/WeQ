import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOAST_DURATIONS } from '@weq/service/toast-settings';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';

let close: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useToast.setState({ toasts: [], leaving: [], durations: { ...DEFAULT_TOAST_DURATIONS } });
});
afterEach(() => {
  close?.();
  close = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(ToastHost)));
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}
const toast = () => useToast.getState().toasts[0]!;

describe('通知倒计时', () => {
  it('成功默认三秒后开始关闭，失败与超时警告默认常驻', async () => {
    const host = mount();
    act(() => {
      useToast.getState().push({ tone: 'success', title: '成功' });
      useToast.getState().push({ tone: 'error', title: '失败' });
      useToast.getState().push({ tone: 'warning', title: '超时' });
    });
    expect(useToast.getState().toasts.map((item) => item.ttl)).toEqual([3000, 0, 0]);
    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(host.textContent).not.toContain('成功');
    expect(host.textContent).toContain('失败');
    expect(host.textContent).toContain('超时');
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(useToast.getState().toasts).toHaveLength(2);
  });
  it('完成态统一遵循偏好，旧调用点显式指定的 ttl 不覆盖用户设置', () => {
    const store = useToast.getState();
    store.setDurations({ successSeconds: 5, failureSeconds: 8 });
    store.push({ tone: 'success', title: '完成', ttl: 9000 });
    expect(toast().ttl).toBe(5000);
    store.update(toast().id, { tone: 'error', ttl: 0 });
    expect(toast().ttl).toBe(8000);
    store.update(toast().id, { tone: 'warning', ttl: 10000 });
    expect(toast().ttl).toBe(8000);
  });
  it('进行中不被成功或失败时长关闭，完成后重新按偏好计时', async () => {
    const host = mount();
    let id = 0;
    act(() => {
      id = useToast.getState().push({ title: '进行中', ttl: 0, dismissible: false });
    });
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(host.textContent).toContain('进行中');
    act(() =>
      useToast
        .getState()
        .update(id, { tone: 'success', title: '已完成', ttl: 0, dismissible: true }),
    );
    expect(toast().ttl).toBe(3000);
    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(useToast.getState().toasts).toHaveLength(0);
  });
  it('加载中的横幅保持常驻，结束时清除加载状态并应用失败偏好', () => {
    const store = useToast.getState();
    store.setDurations({ successSeconds: 3, failureSeconds: 6 });
    const id = store.push({ tone: 'warning', title: '确认中', loading: true, ttl: 0 });
    expect(toast().ttl).toBe(0);
    store.update(id, { tone: 'warning', title: '确认超时', loading: false });
    expect(toast().ttl).toBe(6000);
  });
  it('相同时长的新阶段也重新计时，悬停期间暂停倒计时', async () => {
    const host = mount();
    act(() => useToast.getState().push({ tone: 'success', title: '第一阶段' }));
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    act(() => useToast.getState().update(toast().id, { tone: 'success', title: '第二阶段' }));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(host.textContent).toContain('第二阶段');
    act(() =>
      host
        .querySelector('.weq-toast')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(host.textContent).toContain('已暂停自动关闭');
    act(() =>
      host
        .querySelector('.weq-toast')!
        .dispatchEvent(new MouseEvent('mouseout', { bubbles: true })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(useToast.getState().toasts).toHaveLength(0);
  });
  it('改变偏好立即更新在屏的完成态，不重复读取设置时重置倒计时', () => {
    const store = useToast.getState();
    store.push({ tone: 'error', title: '错误' });
    store.setDurations({ successSeconds: -1, failureSeconds: 5 });
    expect(toast().ttl).toBe(5000);
    const revision = toast().timerRevision;
    store.setDurations({ successSeconds: -1, failureSeconds: 5 });
    expect(toast().timerRevision).toBe(revision);
  });
});
