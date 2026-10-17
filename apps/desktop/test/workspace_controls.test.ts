import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FloatingToolsBar } from '../src/renderer/src/components/FloatingToolsBar';
import { TitleBarSearch } from '../src/renderer/src/components/TitleBarSearch';
import { clampFloatingPosition, floatingToolbarLayout } from '../src/shared/floating_tools';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => vi.unstubAllGlobals());

function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function pointer(target: Element, type: string, options: PointerEventInit = {}) {
  act(() =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, ...options })),
  );
}

describe('标题栏全局搜索', () => {
  it('默认图标，悬停临时展开，点击固定与收起，Escape 不清除关键词', () => {
    const onFocus = vi.fn();
    const view = mount(
      createElement(TitleBarSearch, {
        query: '保留的关键词',
        onQueryChange: vi.fn(),
        onSearchFocus: onFocus,
      }),
    );
    try {
      const area = view.host.firstElementChild!;
      const button = view.host.querySelector('button')!;
      const input = view.host.querySelector('input')!;
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(input.disabled).toBe(true);
      pointer(area, 'pointerover');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      act(() => button.click());
      expect(document.activeElement).toBe(input);
      expect(button.getAttribute('aria-pressed')).toBe('true');
      act(() => button.click());
      expect(button.getAttribute('aria-expanded')).toBe('false');
      pointer(area, 'pointerout');
      pointer(area, 'pointerover');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      act(() => button.click());
      act(() =>
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
      );
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(input.value).toBe('保留的关键词');
      expect(onFocus).toHaveBeenCalled();
    } finally {
      view.dispose();
    }
  });

  it('结果不被标题栏裁剪，点击外部收起', () => {
    const view = mount(
      createElement(TitleBarSearch, {
        query: 'q',
        onQueryChange: vi.fn(),
        results: createElement('button', { id: 'test-search-result' }, '结果'),
      }),
    );
    try {
      const button = view.host.querySelector('button')!;
      act(() => button.click());
      const result = document.getElementById('test-search-result')!;
      expect(view.host.contains(result)).toBe(false);
      pointer(result, 'pointerdown');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      pointer(document.body, 'pointerdown');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(document.getElementById('test-search-result')).toBeNull();
    } finally {
      view.dispose();
    }
  });
});

describe('原地悬浮工具条', () => {
  it('只展开工具条，无对话遮罩；键盘移动、Escape、外部点击可收起', () => {
    const action = vi.fn();
    const view = mount(
      createElement(FloatingToolsBar, {
        items: ['导出', '任务'].map((label) => ({ id: label, label, icon: label, action })),
      }),
    );
    try {
      const trigger = document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!;
      act(() => trigger.click());
      const toolbar = document.querySelector('[role="toolbar"]')!;
      expect(view.host.querySelector('[role="dialog"]')).toBeNull();
      const buttons = toolbar.querySelectorAll('button');
      act(() => buttons[0]!.focus());
      act(() =>
        buttons[0]!.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
        ),
      );
      expect(document.activeElement).toBe(buttons[1]);
      act(() =>
        buttons[1]!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
      );
      expect(document.querySelector('[role="toolbar"]')).toBeNull();
      act(() => trigger.click());
      pointer(document.body, 'pointerdown');
      expect(document.querySelector('[role="toolbar"]')).toBeNull();
      act(() => trigger.click());
      act(() => document.querySelector<HTMLButtonElement>('[role="toolbar"] button')!.click());
      expect(action).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="toolbar"]')).toBeNull();
    } finally {
      view.dispose();
    }
  });

  it('拖动保持边界与位置，松手后的指针点击不误展开，键盘仍可操作', () => {
    const view = mount(createElement(FloatingToolsBar, { items: [] }));
    try {
      const trigger = document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!;
      pointer(trigger, 'pointerdown', { clientX: 900, clientY: 600, button: 0 });
      pointer(trigger, 'pointermove', { clientX: -1000, clientY: -1000 });
      pointer(trigger, 'pointerup', { clientX: -1000, clientY: -1000 });
      expect(window.localStorage.getItem('weq:tools-position')).toBe(
        JSON.stringify({ x: 8, y: 48 }),
      );
      act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      act(() => trigger.click());
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      pointer(trigger, 'pointerdown', { clientX: 20, clientY: 60, button: 0 });
      pointer(trigger, 'pointerup', { clientX: 20, clientY: 60 });
      act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      view.dispose();
    }
    const restored = mount(createElement(FloatingToolsBar, { items: [] }));
    try {
      expect(document.querySelector<HTMLElement>('.weq-floating-tools')?.style.left).toBe('8px');
      expect(document.querySelector<HTMLElement>('.weq-floating-tools')?.style.top).toBe('48px');
    } finally {
      restored.dispose();
    }
  });

  it('各种窗口及拖动位置的工具条不越出横向边界', () => {
    for (const width of [280, 375, 768, 1440]) {
      for (let x = 8; x <= width - 52; x += 1) {
        const point = clampFloatingPosition({ x, y: 400 }, { width, height: 800 });
        const layout = floatingToolbarLayout(point, { width, height: 800 }, 8);
        const barWidth = layout.columns * 40 + 14;
        const left = layout.side === 'left' ? point.x - 6 - barWidth : point.x + 50;
        expect(left).toBeGreaterThanOrEqual(8);
        expect(left + barWidth).toBeLessThanOrEqual(width - 8);
      }
    }
    expect(
      clampFloatingPosition({ x: Number.NaN, y: Infinity }, { width: 375, height: 667 }),
    ).toEqual({ x: 323, y: 615 });
  });
});

describe('搜索移入标题栏后的侧栏布局', () => {
  it.each(['messages', 'contacts'] as const)('%s 不保留旧搜索区的空白', (viewName) => {
    const style = document.createElement('style');
    style.textContent = readFileSync(
      resolve(__dirname, '../src/renderer/src/im-template/styles/sidebar.css'),
      'utf8',
    );
    document.head.append(style);
    const noop = () => {};
    const view = mount(
      createElement(SidebarHeader, {
        user: createTemplateDemoData().user,
        view: viewName,
        showSearch: false,
        query: '',
        onQueryChange: noop,
        onQuickInvite: noop,
        onCreateGroup: noop,
        onOpenProfile: noop,
        onOpenFriendNotices: noop,
        onOpenGroupNotices: noop,
        contactTab: 'friends',
        onContactTabChange: noop,
        activeNotice: null,
      }),
    );
    try {
      const header = view.host.querySelector('.sidebar-header')!;
      expect(window.getComputedStyle(header).paddingTop).toBe('0px');
      expect(window.getComputedStyle(header).paddingBottom).toBe('0px');
      expect(view.host.querySelector('.search-row')).toBeNull();
      if (viewName === 'contacts') {
        expect(window.getComputedStyle(view.host.querySelector('.contact-tools')!).marginTop).toBe(
          '0px',
        );
        expect(view.host.textContent).toContain('好友通知');
        expect(view.host.querySelector('[role="tablist"]')).not.toBeNull();
      }
    } finally {
      view.dispose();
      style.remove();
    }
  });
});
