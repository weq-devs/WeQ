import { act, createElement as h, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Modal } from '../src/renderer/src/components/Dialog';
import { useMobileBack, mobileBack } from '../src/renderer/src/hooks/useMobileNavigation';
import { MobileBackStack } from '../src/renderer/src/lib/mobileNavigation';
import { compareMobileBackEntries } from '../src/renderer/src/lib/mobileBackSurface';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function Category({ close }: { close: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useMobileBack(true, close, 30, () => ref.current);
  return h('section', { ref }, '原设置分类');
}

function layoutFallback() {
  host.querySelector<HTMLElement>('.weq-workspace-page-fallback')!.style.zIndex = '100';
}

it('全局工具页在设置分类之上，返回不先修改背景分类', async () => {
  const category = vi.fn();
  const tool = vi.fn();
  await act(async () =>
    root.render(
      h(
        'div',
        null,
        h(Category, { close: category }),
        h(Modal, { presentation: 'page', title: '数据库浏览', onClose: tool }, '合成记录'),
      ),
    ),
  );
  layoutFallback();
  act(() => expect(mobileBack()).toBe(true));
  expect(tool).toHaveBeenCalledOnce();
  expect(category).not.toHaveBeenCalled();
});

it('工具页内子页先返回，后来打开的确认弹层优先于工具页', async () => {
  const category = vi.fn();
  const tool = vi.fn();
  const child = vi.fn();
  const confirm = vi.fn();
  const render = (dialog: boolean) =>
    root.render(
      h(
        'div',
        null,
        h(Category, { close: category }),
        h(
          Modal,
          { presentation: 'page', title: '工具', onClose: tool },
          h(Category, { close: child }),
        ),
        dialog && h(Modal, { onClose: confirm }, '合成确认'),
      ),
    );
  await act(async () => render(false));
  layoutFallback();
  act(() => expect(mobileBack()).toBe(true));
  expect(child).toHaveBeenCalledOnce();
  expect(tool).not.toHaveBeenCalled();
  await act(async () => render(true));
  act(() => expect(mobileBack()).toBe(true));
  expect(confirm).toHaveBeenCalledOnce();
  expect(child).toHaveBeenCalledOnce();
  expect(category).not.toHaveBeenCalled();
});

it('同层独立工具按绘制顺序返回，再恢复背后工具的子页', () => {
  const stack = new MobileBackStack(compareMobileBackEntries);
  const calls: string[] = [];
  for (const [id, priority] of [
    ['old-child', 50],
    ['new-page', 20],
  ] as const) {
    const target = document.createElement('div');
    target.className = 'weq-workspace-page-fallback';
    target.style.zIndex = '100';
    host.append(target);
    stack.register({ id, priority, target: () => target, back: () => calls.push(id) });
  }
  stack.back();
  stack.back();
  expect(calls).toEqual(['new-page', 'old-child']);
});

it('尚无 DOM 目标的来源快照仍按原业务层级处理', () => {
  const stack = new MobileBackStack(compareMobileBackEntries);
  stack.register({ id: 'root', priority: 10, back: vi.fn() });
  stack.register({ id: 'detail', priority: 30, back: vi.fn() });
  expect(stack.top?.id).toBe('detail');
});
