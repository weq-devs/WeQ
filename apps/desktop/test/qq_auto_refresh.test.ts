// @vitest-environment jsdom
import { act, createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQQAutoRefresh, useQQReadActivity } from '../src/renderer/src/hooks/useQQAutoRefresh';
import {
  RetainedTabs,
  TabActivity,
  useTabActive,
} from '../src/renderer/src/components/RetainedTabs';

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
  it('真实 QueryClient 在保留页失活后停止轮询，不影响当前页读取', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const readers = { a: vi.fn(async () => 'a'), b: vi.fn(async () => 'b') };
    function Reader({ name }: { name: 'a' | 'b' }) {
      const active = useTabActive();
      useQuery(['retained-settings', name], readers[name], {
        enabled: active,
        refetchInterval: 1000,
        refetchIntervalInBackground: true,
        staleTime: 0,
      });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    cleanups.push(() => {
      act(() => root.unmount());
      client.clear();
    });
    const render = (name: 'a' | 'b') =>
      act(() =>
        root.render(
          h(
            QueryClientProvider,
            { client },
            h(RetainedTabs, { activeKey: name }, h(Reader, { name })),
          ),
        ),
      );
    render('a');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(readers.a.mock.calls.length).toBeGreaterThan(1);
    const previous = readers.a.mock.calls.length;
    render('b');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(readers.a).toHaveBeenCalledTimes(previous);
    expect(readers.b.mock.calls.length).toBeGreaterThan(1);
    const other = readers.b.mock.calls.length;
    render('a');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(readers.a.mock.calls.length).toBeGreaterThan(previous);
    expect(readers.b).toHaveBeenCalledTimes(other);
  });
  it('保留但失活的页面释放宿主监听，恢复时只重新读取一次', () => {
    const add = vi.spyOn(window, 'addEventListener'),
      remove = vi.spyOn(window, 'removeEventListener');
    const read = vi.fn();
    function Reader() {
      const activity = useQQReadActivity(true);
      useEffect(() => {
        if (activity.enabled) read();
      }, [activity.enabled, activity.revision]);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    cleanups.push(() => act(() => root.unmount()));
    const render = (active: boolean) =>
      act(() => root.render(h(TabActivity, { active }, h(Reader))));
    render(true);
    const added = add.mock.calls.filter(([event]) =>
      ['focus', 'online', 'offline'].includes(event),
    );
    expect(added).toHaveLength(3);
    render(false);
    for (const [event, listener] of added) expect(remove).toHaveBeenCalledWith(event, listener);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(read).toHaveBeenCalledTimes(1);
    render(true);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('手写页面合并连续恢复事件，隐藏、离线和非活动页均不读取', () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const read = vi.fn();
    let available = true;
    function Reader() {
      const activity = useQQReadActivity(available);
      useEffect(() => {
        if (activity.enabled) read();
      }, [activity.enabled, activity.revision]);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    cleanups.push(() => act(() => root.unmount()));
    const render = () => act(() => root.render(h(Reader)));
    render();
    expect(read).toHaveBeenCalledTimes(1);
    now = 1000;
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(read).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    now = 2000;
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(read).toHaveBeenCalledTimes(3);
    online.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('offline')));
    now = 3000;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(read).toHaveBeenCalledTimes(3);
    available = false;
    render();
    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    expect(read).toHaveBeenCalledTimes(3);
    available = true;
    render();
    expect(read).toHaveBeenCalledTimes(4);
  });
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
