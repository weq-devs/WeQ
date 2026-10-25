import { act, createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogViewerPanel } from '../src/renderer/src/components/settings/LogViewerPanel';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const fixture = vi.hoisted(() => ({
  info: vi.fn(),
  chunk: vi.fn(),
  enabled: new Map<string, boolean>(),
  text: new Map<string, string>(),
  files: [
    { path: '/synthetic/a.log', name: 'a.log', kind: 'weq', mtime: 2, size: 100 },
    { path: '/synthetic/b.log', name: 'b.log', kind: 'weq', mtime: 1, size: 100 },
  ],
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === 'useQuery')
          return (_input: unknown, options: { enabled?: boolean }) => {
            const name = path.at(-1)!;
            useEffect(() => {
              fixture.enabled.set(name, options.enabled !== false);
              return () => {
                fixture.enabled.delete(name);
              };
            }, [name, options.enabled]);
            return {
              data:
                name === 'listLogFiles'
                  ? { files: fixture.files }
                  : { enabled: false, available: true },
              isLoading: false,
              refetch: vi.fn(),
            };
          };
        if (key === 'query') return path.at(-1) === 'logFileInfo' ? fixture.info : fixture.chunk;
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/components/ui/iconPicker', () => ({
  IconPicker: ({
    value,
    onChange,
    options,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
  }) =>
    h(
      'select',
      { 'aria-label': '合成日志选择', value, onChange: (event) => onChange(event.target.value) },
      options.map((option) =>
        h('option', { key: option.value, value: option.value }, option.label),
      ),
    ),
}));
const line = (message: string) => JSON.stringify({ level: 'info', message }) + '\n';
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  fixture.enabled.clear();
  fixture.text = new Map([
    ['/synthetic/a.log', line('a-one')],
    ['/synthetic/b.log', line('b-one')],
  ]);
  fixture.info.mockReset().mockImplementation(async ({ path }: { path: string }) => ({
    size: fixture.text.get(path)!.length,
  }));
  fixture.chunk
    .mockReset()
    .mockImplementation(
      async ({ path, offset, bytes }: { path: string; offset: number; bytes: number }) => ({
        text: fixture.text.get(path)!.slice(offset, offset + bytes),
        nextOffset: Math.min(fixture.text.get(path)!.length, offset + bytes),
      }),
    );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (active = true) =>
    act(() => root.render(h(TabActivity, { active }, h(LogViewerPanel))));
  render();
  return {
    host,
    render,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
describe('日志页保留与活动读取', () => {
  it('已从文件头载入时，恢复后滚到顶部不会重复读取并追加同一段日志', async () => {
    const f = mount();
    try {
      await flush();
      f.render(false);
      f.render(true);
      await flush();
      const view = f.host.querySelector<HTMLElement>('.weq-help-log-view')!;
      Object.defineProperties(view, {
        scrollHeight: { configurable: true, value: 2000 },
        clientHeight: { configurable: true, value: 400 },
      });
      act(() => {
        view.scrollTop = 0;
        view.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await flush();
      expect(fixture.chunk).toHaveBeenCalledOnce();
      expect(f.host.querySelectorAll('.weq-log-line')).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });
  it('隐藏时停止轮询，回来保留文件、筛选、暂停跟随和滚动，只补读新内容', async () => {
    const f = mount();
    try {
      await flush();
      expect(f.host.textContent).toContain('a-one');
      const view = f.host.querySelector<HTMLElement>('.weq-help-log-view')!;
      Object.defineProperties(view, {
        scrollHeight: { configurable: true, value: 2000 },
        clientHeight: { configurable: true, value: 400 },
      });
      act(() => {
        view.scrollTop = 300;
        view.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      const errorFilter = [...f.host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find(
        (button) => button.textContent === 'ERROR',
      )!;
      act(() => errorFilter.click());
      const reads = fixture.info.mock.calls.length;
      f.render(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(fixture.info).toHaveBeenCalledTimes(reads);
      expect([...fixture.enabled.values()]).toEqual([false, false]);
      fixture.text.set('/synthetic/a.log', line('a-one') + line('a-two'));
      f.render(true);
      await flush();
      expect(f.host.querySelector('.weq-help-log-view')).toBe(view);
      expect(view.scrollTop).toBe(300);
      expect(errorFilter.getAttribute('aria-checked')).toBe('false');
      expect(f.host.textContent).toContain('已暂停');
      expect(f.host.textContent).toContain('a-two');
      expect(fixture.chunk.mock.calls.at(-1)?.[0].offset).toBe(line('a-one').length);
    } finally {
      f.dispose();
    }
  });
  it('失活后的迟到文件信息不再派发分块读取；恢复后可重新加载', async () => {
    const pending = deferred<{ size: number }>();
    fixture.info.mockReturnValueOnce(pending.promise);
    const f = mount();
    try {
      f.render(false);
      await act(async () => pending.resolve({ size: line('a-one').length }));
      expect(fixture.chunk).not.toHaveBeenCalled();
      f.render(true);
      await flush();
      expect(f.host.textContent).toContain('a-one');
      expect(fixture.chunk).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });
  it('切文件后旧分块不串入新文件，也不提前结束新文件的加载状态', async () => {
    const oldChunk = deferred<{ text: string; nextOffset: number }>();
    fixture.chunk.mockReturnValueOnce(oldChunk.promise);
    const f = mount();
    try {
      await flush();
      const nextInfo = deferred<{ size: number }>();
      fixture.info.mockReturnValueOnce(nextInfo.promise);
      const select = f.host.querySelector<HTMLSelectElement>('select')!;
      act(() => {
        select.value = '/synthetic/b.log';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await act(async () =>
        oldChunk.resolve({ text: line('stale-a'), nextOffset: line('stale-a').length }),
      );
      expect(f.host.textContent).not.toContain('stale-a');
      expect(f.host.textContent).toContain('正在读取日志');
      await act(async () => nextInfo.resolve({ size: line('b-one').length }));
      await flush();
      expect(f.host.textContent).toContain('b-one');
      expect(select.value).toBe('/synthetic/b.log');
    } finally {
      f.dispose();
    }
  });
  it('隐藏期间文件截断后重载正确文件，但不擅自恢复跟随', async () => {
    fixture.text.set('/synthetic/a.log', line('long-previous-content'));
    const f = mount();
    try {
      await flush();
      const pause = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '实时更新中',
      )!;
      act(() => pause.click());
      f.render(false);
      fixture.text.set('/synthetic/a.log', line('new'));
      f.render(true);
      await flush();
      expect(f.host.textContent).toContain('new');
      expect(f.host.textContent).not.toContain('long-previous-content');
      expect(f.host.textContent).toContain('已暂停');
    } finally {
      f.dispose();
    }
  });
});
