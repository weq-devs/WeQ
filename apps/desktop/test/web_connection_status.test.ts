import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebConnectionStatus } from '../src/renderer/src/components/WebConnectionStatus';
import { useWebConnection } from '../src/renderer/src/state/webConnection';

const { invalidateQueries } = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));
const queryClient = { invalidateQueries };
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useWebConnection.setState({ status: 'connecting', connectedBefore: false, recovery: 0 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(WebConnectionStatus)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it('短暂握手不闪提示，持续连接显示状态，连上即收起', async () => {
  expect(host.textContent).toBe('');
  await act(async () => vi.advanceTimersByTime(1500));
  expect(host.querySelector('[role="status"]')?.textContent).toContain('正在连接电脑');
  await act(async () => useWebConnection.getState().connected());
  expect(host.textContent).toBe('');
  expect(invalidateQueries).not.toHaveBeenCalled();
});

it('重连后仅补查活动读取，不重载页面或重放操作', async () => {
  await act(async () => useWebConnection.getState().connected());
  await act(async () => useWebConnection.getState().disconnected());
  await act(async () => vi.advanceTimersByTime(1500));
  expect(host.textContent).toContain('正在重连');
  await act(async () => useWebConnection.getState().connected());
  expect(invalidateQueries).toHaveBeenCalledOnce();
  expect(invalidateQueries).toHaveBeenCalledWith({ refetchType: 'active' });
  expect(host.textContent).toBe('');
});

it('卸载清理提示计时器', async () => {
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
});
