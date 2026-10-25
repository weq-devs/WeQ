import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ResourceRevisionContext,
  useCursorPaged,
  usePagedList,
} from '../src/renderer/src/views/cache/CacheShared';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const read = vi.fn();
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  read.mockReset().mockResolvedValue({ entries: ['fresh'], nextCursor: null, total: 1 });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function Cursor() {
  const [filter, setFilter] = useState('');
  const data = useCursorPaged<string>((cursor) => read({ cursor, filter }));
  return h(
    'div',
    null,
    h('input', { value: filter, onChange: (event) => setFilter(event.target.value) }),
    h('p', null, data.entries.join(',')),
    h('div', { ref: data.sentinelRef }),
  );
}
function Offset() {
  const [filter, setFilter] = useState('');
  const data = usePagedList<string>((offset, limit) => read({ offset, limit, filter }), filter);
  return h(
    'div',
    null,
    h('input', { value: filter, onChange: (event) => setFilter(event.target.value) }),
    h('p', null, data.entries.join(',')),
    h('div', { ref: data.sentinelRef }),
  );
}
async function mount(kind: 'cursor' | 'offset', initialActive = true) {
  const host = document.createElement('div'),
    root = createRoot(host);
  const Widget = kind === 'cursor' ? Cursor : Offset;
  const render = async (active = true, revision = 0) =>
    act(async () =>
      root.render(
        h(
          TabActivity,
          { active },
          h(ResourceRevisionContext.Provider, { value: revision }, h(Widget)),
        ),
      ),
    );
  cleanups.push(() => act(() => root.unmount()));
  await render(initialActive);
  return { host, render };
}
it.each(['cursor', 'offset'] as const)(
  '%s 隐藏期间不首读或因清理修订续读，恢复后只读一次',
  async (kind) => {
    const page = await mount(kind, false);
    await page.render(false, 1);
    expect(read).not.toHaveBeenCalled();
    await page.render(true, 1);
    expect(read).toHaveBeenCalledOnce();
    expect(page.host.querySelector('p')?.textContent).toBe('fresh');
  },
);
it.each(['cursor', 'offset'] as const)(
  '%s 丢弃隐藏后的迟到页，恢复重新读取而不追加旧条目',
  async (kind) => {
    let finish!: (value: { entries: string[]; nextCursor: null; total: number }) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const page = await mount(kind);
    await page.render(false);
    await act(async () => finish({ entries: ['old-private'], nextCursor: null, total: 1 }));
    expect(page.host.querySelector('p')?.textContent).toBe('');
    await page.render();
    expect(read).toHaveBeenCalledTimes(2);
    expect(page.host.querySelector('p')?.textContent).toBe('fresh');
  },
);
it.each(['cursor', 'offset'] as const)(
  '%s 清理后刷新数据但保留筛选输入与控件实例',
  async (kind) => {
    const page = await mount(kind),
      input = page.host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'keep-filter',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const count = read.mock.calls.length;
    await page.render(true, 1);
    expect(read).toHaveBeenCalledTimes(count + 1);
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ filter: 'keep-filter' }));
    expect(page.host.querySelector('input')).toBe(input);
    expect(input.value).toBe('keep-filter');
  },
);
