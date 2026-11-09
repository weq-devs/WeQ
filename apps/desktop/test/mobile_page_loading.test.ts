import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MOBILE_PAGE_SETTLE_MS,
  preloadMobilePages,
  setMobileNavigationBusy,
} from '../src/renderer/src/lib/mobilePageLoading';
import { useMobilePageSettled } from '../src/renderer/src/hooks/useMobilePageSettled';
import { MobileSidebarPages } from '../src/renderer/src/components/MobileSidebarPages';

vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
let mobile = true;
let hidden = false;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  mobile = true;
  hidden = false;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: mobile,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  // 同时覆盖没有 requestIdleCallback 的手机 WebView。
  vi.stubGlobal('requestIdleCallback', undefined);
  setMobileNavigationBusy(false);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('逐个预加载，失败继续；手势和后台暂停，销毁后不再启动', async () => {
  const first = vi.fn(async () => {
    throw new Error('fixture');
  });
  const second = vi.fn(async () => {});
  const third = vi.fn(async () => {});
  cleanup = preloadMobilePages([first, second, third]);
  expect(first).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(80);
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  setMobileNavigationBusy(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(second).not.toHaveBeenCalled();
  hidden = true;
  setMobileNavigationBusy(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(second).not.toHaveBeenCalled();
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(80);
  expect(second).toHaveBeenCalledOnce();
  cleanup();
  await vi.runAllTimersAsync();
  expect(third).not.toHaveBeenCalled();
});

it('支持空闲回调，取消后不会启动模块请求', () => {
  const idle = vi.fn(() => 123);
  const cancel = vi.fn();
  vi.stubGlobal('requestIdleCallback', idle);
  vi.stubGlobal('cancelIdleCallback', cancel);
  const load = vi.fn(async () => {});
  cleanup = preloadMobilePages([load]);
  expect(idle).toHaveBeenCalledOnce();
  cleanup();
  expect(cancel).toHaveBeenCalledWith(123);
  expect(load).not.toHaveBeenCalled();
});

function Page({ active, account = 'fixture' }: { active: boolean; account?: string }) {
  const ready = useMobilePageSettled(active, account);
  return createElement('span', null, String(ready));
}
const render = (active: boolean, account?: string) =>
  act(() => root.render(createElement(Page, { active, account })));
const advance = async (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

it('空间只在停稳后放行，快速划过不加载，切换账号重新等待', async () => {
  render(true);
  expect(host.textContent).toBe('false');
  await advance(MOBILE_PAGE_SETTLE_MS - 1);
  render(false);
  await advance(MOBILE_PAGE_SETTLE_MS);
  expect(host.textContent).toBe('false');
  render(true);
  await advance(MOBILE_PAGE_SETTLE_MS);
  expect(host.textContent).toBe('true');
  render(true, 'other-account');
  expect(host.textContent).toBe('false');
  await advance(MOBILE_PAGE_SETTLE_MS);
  expect(host.textContent).toBe('true');
});

it('滑动和切后台立即暂停，取消滑动或回到前台后重新等待', async () => {
  render(true);
  act(() => setMobileNavigationBusy(true));
  await advance(1000);
  expect(host.textContent).toBe('false');
  act(() => setMobileNavigationBusy(false));
  await advance(MOBILE_PAGE_SETTLE_MS);
  expect(host.textContent).toBe('true');
  act(() => {
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(host.textContent).toBe('false');
  await advance(1000);
  expect(host.textContent).toBe('false');
  act(() => {
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await advance(MOBILE_PAGE_SETTLE_MS);
  expect(host.textContent).toBe('true');
});

it('桌面页面不增加停稳等待', () => {
  mobile = false;
  render(true);
  expect(host.textContent).toBe('true');
  render(false);
  expect(host.textContent).toBe('false');
});

it('手机预渲染消息和联系人，切页复用节点；其他页面不后台挂载', async () => {
  const mounted = vi.fn();
  function List({ view }: { view: string }) {
    useEffect(() => {
      mounted(view);
    }, [view]);
    return createElement('input', { 'aria-label': view });
  }
  const show = (activeKey: 'messages' | 'contacts' | 'qzone') =>
    act(() =>
      root.render(
        createElement(MobileSidebarPages, {
          activeKey,
          renderPage: (view) => createElement(List, { view }),
        }),
      ),
    );
  show('messages');
  expect(mounted.mock.calls).toEqual([['messages']]);
  await advance(80);
  expect(mounted.mock.calls).toEqual([['messages'], ['contacts']]);
  const contacts = host.querySelector('input[aria-label="contacts"]');
  show('contacts');
  expect(host.querySelector('input[aria-label="contacts"]')).toBe(contacts);
  expect(mounted).toHaveBeenCalledTimes(2);
  expect(host.querySelectorAll('[data-mobile-sidebar-active="true"]')).toHaveLength(1);
  expect(host.querySelector('input[aria-label="messages"]')?.closest('[hidden]')).toBeTruthy();
});
