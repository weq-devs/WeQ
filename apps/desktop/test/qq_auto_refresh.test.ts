// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQQAutoRefresh } from '../src/renderer/src/hooks/useQQAutoRefresh';

const cleanups: Array<() => void> = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(read: () => Promise<string>) {
  const client = new QueryClient({ logger: { log() {}, warn() {}, error() {} } });
  const host = document.createElement('div');
  const root = createRoot(host);
  function Reader({ source }: { source: string }) {
    useQuery(['read', source], read, useQQAutoRefresh(true));
    return null;
  }
  const render = (source = 'a') =>
    act(() => root.render(h(QueryClientProvider, { client }, h(Reader, { source, key: source }))));
  cleanups.push(() => {
    act(() => root.unmount());
    client.clear();
  });
  render();
  return { client, render };
}

describe('QQ 自动读取', () => {
  it('进入与恢复前台自动更新，隐藏及离线时不读取', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const read = vi.fn(async () => 'ok');
    fixture(read);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    online.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('offline')));
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('读取失败最多重试两次，切换来源后停止旧查询重试', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const read = vi.fn(async () => {
      throw new Error('读取失败');
    });
    const f = fixture(read);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(read).toHaveBeenCalledTimes(3);
    f.render('b');
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(4);
    f.render('c');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(read).toHaveBeenCalledTimes(7);
  });

  it('失败重试在隐藏期间暂停，恢复后继续且不增加重试预算', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const read = vi.fn(async () => {
      throw new Error('读取失败');
    });
    fixture(read);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(read).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(read).toHaveBeenCalledTimes(3);
  });
});
