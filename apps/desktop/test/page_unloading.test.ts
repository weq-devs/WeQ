import {
  act,
  createElement as h,
  useEffect,
  startTransition,
  Suspense,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { RetainedTabs, TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { PageSnapshots, usePageState } from '../src/renderer/src/components/PageSnapshots';
import {
  createPageSnapshotStorage,
  PAGE_SNAPSHOT_MAX_BYTES,
  PAGE_SNAPSHOT_MAX_ENTRIES,
  pageValue,
} from '../src/renderer/src/lib/pageSnapshots';
import { useToast } from '../src/renderer/src/components/Toast';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  useToast.setState({ toasts: [] });
});

it('被挂起后取消的来源切换不影响仍在显示的页面输入', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  const root = createRoot(host);
  let navigate: Dispatch<SetStateAction<string>> = () => {};
  let write: Dispatch<SetStateAction<string>> = () => {};
  const pending = new Promise<void>(() => {});
  function Editor({ source }: { source: string }) {
    const [value, set] = usePageState('draft', '', pageValue.string, true);
    write = set;
    if (source === 'b') throw pending;
    return h('span', null, value);
  }
  function App() {
    const [scope, setScope] = useState('a');
    navigate = setScope;
    return h(
      PageSnapshots,
      { scope },
      h(Suspense, { fallback: 'pending' }, h(Editor, { source: scope })),
    );
  }
  try {
    act(() => root.render(h(App)));
    const committed = write;
    await act(async () => startTransition(() => navigate('b')));
    act(() => committed('仍在编辑的草稿'));
    act(() => navigate('a'));
    expect(host.textContent).toBe('仍在编辑的草稿');
  } finally {
    act(() => root.unmount());
  }
});

it('磁盘快照支持 Set、空值和重建，按账号/数据源隔离且忽略卸载后的迟到更新', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  const root = createRoot(host);
  let write: Dispatch<SetStateAction<Set<string>>> = () => {};
  let writeProfile: Dispatch<SetStateAction<{ id: string; extra?: string }>> = () => {};
  function Page() {
    const [value, set] = usePageState('selection', new Set<string>(), pageValue.stringSet);
    const [, profile] = usePageState<{ id: string; extra?: string }>(
      'profile',
      { id: 'initial' },
      z.object({ id: z.string() }),
    );
    writeProfile = profile;
    write = set;
    return h('span', null, [...value].join(','));
  }
  const render = (scope: string, page: string) =>
    act(() =>
      root.render(
        h(
          PageSnapshots,
          { scope },
          h(
            RetainedTabs,
            { snapshotKey: 'main', activeKey: page },
            page === 'a' ? h(Page) : h('div'),
          ),
        ),
      ),
    );
  try {
    render('account-a:source-a', 'a');
    act(() => {
      write(new Set(['one']));
      write((value) => new Set([...value, 'two']));
      writeProfile({ id: 'chosen', extra: 'not-snapshot' });
    });
    const stale = write;
    render('account-a:source-a', 'b');
    act(() => stale(new Set(['late'])));
    render('account-a:source-a', 'a');
    expect(host.textContent).toBe('one,two');
    render('account-a:source-b', 'a');
    expect(host.textContent).toBe('');
    act(() => write(new Set(['source-b'])));
    render('account-a:source-a', 'a');
    expect(host.textContent).toBe('one,two');
    expect(localStorage.length).toBe(3);
    expect(
      Array.from({ length: localStorage.length }, (_, i) =>
        localStorage.getItem(localStorage.key(i)!),
      ).join(''),
    ).not.toContain('not-snapshot');
  } finally {
    act(() => root.unmount());
  }
});

it('坏快照和不匹配的类型不覆盖原件；写入容量有界且草稿不被页面缓存淘汰', () => {
  const storage = new Storage();
  const snapshots = createPageSnapshotStorage(() => storage);
  snapshots.write('set', new Set(['a']));
  expect(snapshots.read('set', pageValue.stringSet)).toEqual(new Set(['a']));
  snapshots.write('null', null);
  expect(snapshots.read('null', z.string().nullable())).toBeNull();
  const key = Array.from({ length: storage.length }, (_, i) => storage.key(i)!).find((key) =>
    key.endsWith('set'),
  )!;
  const old = storage.getItem(key);
  expect(() => snapshots.read('set', z.number())).toThrow();
  expect(storage.getItem(key)).toBe(old);
  storage.setItem('weq:page-snapshot:v1:bad', '{');
  expect(() => snapshots.read('bad', pageValue.string)).toThrow();
  snapshots.write('new', 'valid');
  expect(storage.getItem('weq:page-snapshot:v1:bad')).toBe('{');
  expect(() => snapshots.write('oversized', 'x'.repeat(PAGE_SNAPSHOT_MAX_BYTES))).toThrow();
  snapshots.write('draft', 'user input', true);
  snapshots.confirm('draft', 'older value');
  expect(snapshots.read('draft', pageValue.string, true)).toBe('user input');
  for (let i = 0; i < PAGE_SNAPSHOT_MAX_ENTRIES + 2; i++) snapshots.write(`entry-${i}`, i);
  expect(storage.length).toBeLessThanOrEqual(PAGE_SNAPSHOT_MAX_ENTRIES + 1);
  expect(snapshots.read('draft', pageValue.string, true)).toBe('user input');
  snapshots.confirm('draft', 'user input');
  expect(snapshots.read('draft', pageValue.string, true)).toBeUndefined();
});

it('磁盘写失败时报告错误并只暂存输入数据，页面仍可卸载与恢复', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const storage = new Storage();
  vi.spyOn(storage, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  vi.stubGlobal('localStorage', storage);
  const host = document.createElement('div');
  const root = createRoot(host);
  let write: Dispatch<SetStateAction<string>> = () => {};
  function Page() {
    const [value, set] = usePageState('draft', '', pageValue.string, true);
    write = set;
    return h('textarea', { value, readOnly: true });
  }
  const render = (activeKey: string) =>
    act(() =>
      root.render(
        h(
          PageSnapshots,
          { scope: 'account' },
          h(
            RetainedTabs,
            { snapshotKey: 'main', activeKey },
            activeKey === 'a' ? h(Page) : h('div'),
          ),
        ),
      ),
    );
  try {
    render('a');
    act(() => write('not lost'));
    render('b');
    expect(host.querySelector('textarea')).toBeNull();
    render('a');
    expect(host.querySelector('textarea')!.value).toBe('not lost');
    expect(useToast.getState().toasts.some((toast) => toast.title === '页面现场保存失败')).toBe(
      true,
    );
  } finally {
    act(() => root.unmount());
  }
});

it('重建后的消息高度改变时按消息锚点恢复，而不是直接复用旧像素坐标', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let height = 60;
  function Messages() {
    return h(
      'div',
      {
        className: 'message-scroll',
        ref: (element: HTMLDivElement | null) => {
          if (element) element.getBoundingClientRect = () => new DOMRect(0, 100, 400, 200);
        },
      },
      ...Array.from({ length: 12 }, (_, index) =>
        h(
          'div',
          {
            key: index,
            className: 'message-line',
            'data-message-id': `row-${index}`,
            ref: (element: HTMLDivElement | null) => {
              if (element)
                element.getBoundingClientRect = () =>
                  new DOMRect(
                    0,
                    100 + index * height - element.parentElement!.scrollTop,
                    400,
                    height,
                  );
            },
          },
          `message-${index}`,
        ),
      ),
    );
  }
  const render = (activeKey: string) =>
    act(() =>
      root.render(
        h(
          PageSnapshots,
          { scope: 'account' },
          h(
            RetainedTabs,
            { snapshotKey: 'main', activeKey },
            activeKey === 'a' ? h(Messages) : h('div'),
          ),
        ),
      ),
    );
  try {
    render('a');
    const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
    act(() => {
      scroll.scrollTop = 180;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    render('b');
    height = 80;
    render('a');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.querySelector<HTMLElement>('.message-scroll')!.scrollTop).toBe(240);
  } finally {
    act(() => root.unmount());
  }
});

it('用户中断等待中的滚动恢复后，迟到图片加载不能再次套用旧坐标', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (activeKey: string) =>
    act(() =>
      root.render(
        h(
          PageSnapshots,
          { scope: 'account' },
          h(
            RetainedTabs,
            { snapshotKey: 'main', activeKey },
            activeKey === 'a'
              ? h('div', { 'data-scroll': true }, h('img', { alt: 'pending' }))
              : h('div'),
          ),
        ),
      ),
    );
  try {
    render('a');
    const original = host.querySelector<HTMLElement>('[data-scroll]')!;
    act(() => {
      original.scrollTop = 500;
      original.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    render('b');
    render('a');
    const scroll = host.querySelector<HTMLElement>('[data-scroll]')!;
    act(() => {
      scroll.scrollTop = 35;
      scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      Object.defineProperty(scroll, 'scrollHeight', { value: 1000 });
      scroll.querySelector('img')!.dispatchEvent(new Event('load'));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(scroll.scrollTop).toBe(35);
  } finally {
    act(() => root.unmount());
  }
});

it('切页和祖先失活时卸载旧页面及其资源，而不是继续隐藏驻留', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const release = vi.fn();
  function Page({ name }: { name: string }) {
    useEffect(() => () => release(name), [name]);
    return h('video', { 'data-page': name });
  }
  const render = (name: string, active = true) =>
    act(() =>
      root.render(
        h(TabActivity, { active }, h(RetainedTabs, { activeKey: name }, h(Page, { name }))),
      ),
    );
  try {
    render('messages');
    render('home');
    expect(host.querySelector('[data-page="messages"]')).toBeNull();
    expect(host.querySelectorAll('video')).toHaveLength(1);
    expect(release).toHaveBeenCalledWith('messages');
    render('home', false);
    expect(host.querySelector('video')).toBeNull();
    expect(release).toHaveBeenCalledWith('home');
  } finally {
    act(() => root.unmount());
  }
});
