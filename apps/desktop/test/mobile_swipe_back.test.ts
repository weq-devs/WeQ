import { act, createElement, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileNavigationRuntime } from '../src/renderer/src/components/MobileNavigationRuntime';
import { WorkspacePage } from '../src/renderer/src/components/WorkspacePages';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { mobileBack, useMobileBack } from '../src/renderer/src/hooks/useMobileNavigation';
import { useSurfaceEscape } from '../src/renderer/src/lib/surfaceEscape';
import { isMobileNavigationBusy } from '../src/renderer/src/lib/mobilePageLoading';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let closed: ReturnType<typeof vi.fn>;
let categoryBack: ReturnType<typeof vi.fn>;
let animations: Array<{ finish: () => void; cancel: ReturnType<typeof vi.fn> }>;

function Fixture({ portal = false }: { portal?: boolean }) {
  const shell = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const [category, setCategory] = useState(true);
  useMobileBack(
    category,
    () => {
      categoryBack();
      setCategory(false);
    },
    30,
    () => page.current,
  );
  const content = createElement(
    'div',
    { ref: page, 'data-testid': 'category' },
    createElement('input'),
    createElement('div', { 'data-testid': 'pan', style: { touchAction: 'none' } }),
    createElement('video', { controls: true }),
    createElement('div', { 'data-no-swipe-back': true }),
    createElement('div', { 'data-testid': 'scroller', style: { overflowX: 'auto' } }),
    category ? '二级设置' : '设置分类',
  );
  return createElement(
    'div',
    { ref: shell },
    createElement(MobileNavigationRuntime, { root: shell }),
    createElement(
      WorkspacePage,
      { title: '设置', onClose: closed },
      portal ? createPortal(content, document.body) : content,
    ),
  );
}

function ModalFixture({ dismissable = true }: { dismissable?: boolean }) {
  const shell = useRef<HTMLDivElement>(null);
  const modal = useRef<HTMLDivElement>(null);
  useSurfaceEscape(modal, dismissable ? closed : undefined, true, true);
  return createElement(
    'div',
    { ref: shell },
    createElement(MobileNavigationRuntime, { root: shell }),
    createPortal(
      createElement(
        'div',
        {
          ref: modal,
          role: 'dialog',
          'aria-modal': true,
          'data-testid': 'modal',
        },
        '弹窗',
      ),
      document.body,
    ),
  );
}

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media) =>
      Object.assign(new EventTarget(), {
        matches: media.includes('max-width'),
        media,
      }) as MediaQueryList,
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
  animations = [];
  vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(() => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cancel = vi.fn();
    animations.push({ finish, cancel });
    return { finished, cancel } as unknown as Animation;
  });
  // 单测聚焦手势与页面提交，不依赖模拟 DOM 的浏览历史时序。
  vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
  vi.spyOn(window.history, 'back').mockImplementation(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  });
  closed = vi.fn();
  categoryBack = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function touch(target: Element, type: string, x: number, y = 280, count = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { identifier: 1, target, clientX: x, clientY: y };
  Object.defineProperties(event, {
    touches: {
      value: type === 'touchend' || type === 'touchcancel' ? [] : Array(count).fill(point),
    },
    changedTouches: { value: [point] },
  });
  target.dispatchEvent(event);
  return event;
}

it('工作区只登记一次返回，二级设置先退到分类而不是关闭整页', async () => {
  await act(async () => root.render(createElement(Fixture)));
  await act(async () => {
    expect(mobileBack()).toBe(true);
  });
  expect(categoryBack).toHaveBeenCalledOnce();
  expect(closed).not.toHaveBeenCalled();
});

it('斜向起手仍按主要方向跟手，取消后完整回弹且不退出页面', async () => {
  await act(async () => root.render(createElement(Fixture)));
  const page = host.querySelector('[data-testid="category"]') as HTMLElement;
  touch(page, 'touchstart', 4);
  const move = touch(page, 'touchmove', 64, 294);
  expect(move.defaultPrevented).toBe(true);
  expect(page.style.transform).toBe('translateX(60px)');
  touch(page, 'touchcancel', 64, 294);
  expect(isMobileNavigationBusy()).toBe(true);
  await act(async () => animations.at(-1)!.finish());
  expect(page.style.transform).toBe('');
  expect(isMobileNavigationBusy()).toBe(false);
  expect(categoryBack).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
});

it('Portal 浮层可从左缘返回，页面后的其他层不响应', async () => {
  await act(async () => root.render(createElement(ModalFixture)));
  const modal = document.querySelector('[data-testid="modal"]') as HTMLElement;
  touch(modal, 'touchstart', 4);
  touch(modal, 'touchmove', 164);
  expect(modal.style.transform).toBe('translateX(160px)');
  touch(modal, 'touchend', 164);
  await act(async () => animations.at(-1)!.finish());
  expect(closed).toHaveBeenCalledOnce();
});

it.each([
  'input',
  'video',
  '[data-testid="pan"]',
  '[data-no-swipe-back]',
  '[data-testid="scroller"]',
])('%s 保留原生编辑或横向滚动，不抢返回手势', async (selector) => {
  await act(async () => root.render(createElement(Fixture)));
  const target = host.querySelector(selector)!;
  if (selector.includes('scroller')) Object.defineProperty(target, 'scrollWidth', { value: 800 });
  touch(target, 'touchstart', 4);
  expect(touch(target, 'touchmove', 164).defaultPrevented).toBe(false);
  touch(target, 'touchend', 164);
  expect(categoryBack).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
});

it('回弹进行中不接受第二次手势，不会由旧动画清除新手势', async () => {
  await act(async () => root.render(createElement(Fixture)));
  animations = [];
  const page = host.querySelector('[data-testid="category"]') as HTMLElement;
  touch(page, 'touchstart', 4);
  touch(page, 'touchmove', 24);
  touch(page, 'touchend', 24);
  touch(page, 'touchstart', 4);
  touch(page, 'touchmove', 164);
  expect(animations).toHaveLength(1);
  expect(page.style.transform).toBe('translateX(0px)');
  await act(async () => animations[0]!.finish());
  expect(page.style.transform).toBe('');
  expect(categoryBack).not.toHaveBeenCalled();
});

it('不可关闭的顶层弹窗阻止向后操作底层页面', async () => {
  await act(async () => root.render(createElement(Fixture)));
  const blocker = document.createElement('div');
  blocker.setAttribute('role', 'dialog');
  document.body.append(blocker);
  try {
    touch(blocker, 'touchstart', 4);
    expect(touch(blocker, 'touchmove', 164).defaultPrevented).toBe(false);
    touch(blocker, 'touchend', 164);
    expect(categoryBack).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  } finally {
    blocker.remove();
  }
});

it('离开可见标签后不遗留返回动作，再激活后恢复登记', async () => {
  const render = (active: boolean) =>
    root.render(createElement(TabActivity, { active }, createElement(Fixture)));
  await act(async () => render(true));
  await act(async () => render(false));
  expect(mobileBack()).toBe(false);
  await act(async () => render(true));
  await act(async () => {
    expect(mobileBack()).toBe(true);
  });
  expect(categoryBack).toHaveBeenCalledOnce();
  expect(closed).not.toHaveBeenCalled();
});

it('宽窗转窄窗后给已打开页面补齐返回入口', async () => {
  let narrow = false;
  vi.mocked(window.matchMedia).mockImplementation(
    (media) =>
      Object.assign(new EventTarget(), {
        matches: narrow && media.includes('max-width'),
        media,
      }) as MediaQueryList,
  );
  await act(async () => root.render(createElement(Fixture)));
  expect(mobileBack()).toBe(false);
  await act(async () => {
    narrow = true;
    window.dispatchEvent(new Event('resize'));
  });
  await act(async () => {
    expect(mobileBack()).toBe(true);
  });
  expect(categoryBack).toHaveBeenCalledOnce();
  expect(closed).not.toHaveBeenCalled();
});

it.each(['touchcancel', 'resize', 'blur', 'multitouch', 'second-finger'])(
  '%s 中断后清除动画与繁忙状态，不触发返回',
  async (reason) => {
    await act(async () => root.render(createElement(Fixture)));
    const page = host.querySelector('[data-testid="category"]') as HTMLElement;
    touch(page, 'touchstart', 4);
    touch(page, 'touchmove', 164);
    if (reason === 'resize' || reason === 'blur') window.dispatchEvent(new Event(reason));
    else {
      touch(
        page,
        reason === 'multitouch'
          ? 'touchmove'
          : reason === 'second-finger'
            ? 'touchstart'
            : 'touchcancel',
        164,
        280,
        reason === 'multitouch' || reason === 'second-finger' ? 2 : 1,
      );
      await act(async () => animations.at(-1)!.finish());
    }
    expect(page.style.transform).toBe('');
    expect(isMobileNavigationBusy()).toBe(false);
    expect(categoryBack).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  },
);

it('跟手移动复用起手屏宽，不在每次 touchmove 强制读取布局', async () => {
  await act(async () => root.render(createElement(Fixture)));
  const page = host.querySelector('[data-testid="category"]') as HTMLElement;
  touch(page, 'touchstart', 4);
  const read = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get');
  read.mockClear();
  for (let distance = 10; distance <= 160; distance += 10) touch(page, 'touchmove', 4 + distance);
  expect(read).not.toHaveBeenCalled();
  touch(page, 'touchcancel', 164);
  await act(async () => animations.at(-1)!.finish());
});
