import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useRecentContactHeadRefresh } from '../src/renderer/src/hooks/useRecentContactHeadRefresh';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const load = vi.fn(async () => ({ isError: false }));
  let request!: () => void;
  function Probe({ scope }: { scope: string }) {
    request = useRecentContactHeadRefresh(load, scope);
    return null;
  }
  const render = (scope = 'source-a') => {
    act(() => root.render(h(StrictMode, null, h(Probe, { scope }))));
  };
  const unmount = () => act(() => root.unmount());
  cleanups.push(unmount);
  render();
  return { load, render, request: () => request(), callback: () => request, unmount };
}

it('开发模式 effect 重挂载后，新消息仍触发最新会话查询，并合并同轮事件', async () => {
  const f = fixture();
  f.request();
  f.request();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.load).toHaveBeenCalledOnce();
  expect(f.load).toHaveBeenLastCalledWith({ cancelRefetch: false });
  f.request();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.load).toHaveBeenCalledTimes(2);
});

it('换来源取消旧定时任务，新来源继续刷新，卸载后不再查询', async () => {
  const f = fixture();
  f.request();
  f.render('source-b');
  await vi.advanceTimersByTimeAsync(100);
  expect(f.load).not.toHaveBeenCalled();
  f.request();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.load).toHaveBeenCalledOnce();
  f.request();
  f.unmount();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.load).toHaveBeenCalledOnce();
  cleanups.length = 0;
});

it('同来源重绘保留排队刷新，旧来源的迟到回调不会刷新新账号', async () => {
  const f = fixture();
  f.request();
  f.render();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.load).toHaveBeenCalledOnce();
  const oldRequest = f.callback();
  f.render('source-b');
  oldRequest();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.load).toHaveBeenCalledOnce();
  f.request();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.load).toHaveBeenCalledTimes(2);
});
