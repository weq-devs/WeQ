import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from '../src/renderer/src/components/Toast';
import { sourceToastPush, useToast } from '../src/renderer/src/components/Toast.shared';
import { installAccountBannerRouting } from '../src/renderer/src/lib/accountBanners';
import { bindAccountState } from '../src/renderer/src/lib/clientPreferences';
import { notificationSource } from '../src/renderer/src/lib/notificationNavigation.shared';
import { useAccountSwitch } from '../src/renderer/src/state/accountSwitch';
import { useViewState } from '../src/renderer/src/state/view';

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
  it('登录和切号期间只保留应用横幅，迟到的旧账号或旧数据源结果不能进入当前窗口', () => {
    const stop = installAccountBannerRouting();
    const toast = useToast.getState();
    const view = useViewState.getState();
    const switchState = useAccountSwitch.getState();
    const live = { expectedAccountUin: '10001', expectedAccountConfigId: 'live' };
    const backup = { ...live, expectedAccountConfigId: 'backup' };
    const other = { ...live, expectedAccountUin: '10002' };
    const push = (title: string, account?: typeof live) =>
      toast.push({ title, account, system: false });
    try {
      expect(push('登录页上的账号消息', live)).toBe(0);
      const appBanner = toast.push({ title: '更新可用', appWide: true, system: false });
      view.setOpenedUin(live.expectedAccountUin);
      view.goTo('main');
      bindAccountState(live);
      const late = sourceToastPush(notificationSource({ kind: 'assistant' }));
      expect(push('本账号消息', live)).toBeGreaterThan(0);
      expect(push('其他账号消息', other)).toBe(0);
      expect(push('其他数据源消息', backup)).toBe(0);

      switchState.begin('正在切换');
      expect(useToast.getState().toasts.map(({ id }) => id)).toEqual([appBanner]);
      expect(push('切号中的消息')).toBe(0);
      bindAccountState(backup);
      switchState.end();
      expect(push('新数据源消息', backup)).toBeGreaterThan(0);
      expect(late({ title: '旧数据源的迟到结果', system: false })).toBe(0);
      view.goTo('bootstrap');
      expect(useToast.getState().toasts.map(({ id }) => id)).toEqual([appBanner]);

      bindAccountState(live);
      view.goTo('main');
      expect(late({ title: '前一次会话的迟到结果', system: false })).toBe(0);
    } finally {
      stop();
      bindAccountState(null);
      view.setOpenedUin(null);
      view.goTo('bootstrap');
      switchState.end();
      useToast.setState({ account: undefined });
    }
  });

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

  it('手动关闭同一进度后，后续进度不会取消退场或重新插入，结果和下一轮照常显示', async () => {
    const host = mount();
    const store = useToast.getState();
    const progress = { key: 'operation', loading: true, system: false } as const;
    act(() => store.push({ ...progress, title: '开始处理' }));
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click());
    act(() => store.push({ ...progress, title: '继续处理' }));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(useToast.getState().toasts).toHaveLength(0);
    act(() => store.push({ ...progress, title: '仍在处理' }));
    expect(useToast.getState().toasts).toHaveLength(0);
    act(() => store.push({ ...progress, loading: false, title: '处理完成' }));
    expect(useToast.getState().toasts[0]?.event).toBe('taskComplete');
    act(() => store.push({ ...progress, title: '下一轮开始' }));
    expect(useToast.getState().toasts[0]?.title).toBe('下一轮开始');
  });

  it('退场期间同一问题再次出现时取消旧退场，下一阶段从头计时', async () => {
    const host = mount();
    let id = 0;
    act(() => {
      id = useToast.getState().push({ key: 'a', tone: 'warning', title: '旧问题' });
    });
    const row = host.querySelector('.weq-toast');
    const slot = row!.parentElement!;
    act(() => useToast.getState().resolve('a'));
    expect(slot.classList.contains('is-leaving')).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    act(() => {
      expect(useToast.getState().push({ key: 'a', tone: 'success', title: '新阶段' })).toBe(id);
    });
    expect(host.querySelector('.weq-toast')).toBe(row);
    expect(row!.parentElement).toBe(slot);
    expect(slot.classList.contains('is-leaving')).toBe(false);
    expect(useToast.getState().leaving).not.toContain(id);
    await act(async () => vi.advanceTimersByTimeAsync(2900));
    expect(host.textContent).toContain('新阶段');
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(host.querySelector('.weq-toast')).toBeNull();
  });
});
