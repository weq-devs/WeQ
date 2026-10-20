import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FloatingToolsBar } from '../src/renderer/src/components/FloatingToolsBar';
import { RailUtilityDock } from '../src/renderer/src/components/RailUtilityDock';
import { floatingDockHit } from '../src/shared/floating_tools';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(docked?: boolean, storage = new Storage()) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  if (docked !== undefined) storage.setItem('weq:tools-docked', String(docked));
  vi.stubGlobal('localStorage', storage);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(
        'div',
        null,
        createElement(
          RailUtilityDock,
          null,
          ...['截图', '隐私', '主题', '锁定'].map((name) =>
            createElement('button', { key: name, type: 'button' }, name),
          ),
        ),
        createElement(FloatingToolsBar, {
          items: [{ id: 'export', label: '导出', icon: null, action: vi.fn() }],
        }),
      ),
    ),
  );
  const slot = host.querySelector<HTMLElement>('[data-weq-tools-dock]')!;
  vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 590, 46, 34));
  act(() => window.dispatchEvent(new Event('resize')));
  return {
    host,
    root,
    slot,
    storage,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function pointer(button: Element, name: string, x: number, y: number) {
  act(() =>
    button.dispatchEvent(
      new PointerEvent(name, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }),
    ),
  );
}

describe('左栏快捷控制与工具吸附', () => {
  it('没有布局偏好时默认吸附', () => {
    const f = mount();
    try {
      const tools = document.querySelector<HTMLElement>('.weq-floating-tools')!;
      expect(tools.classList.contains('is-docked')).toBe(true);
      expect(tools.style.left).toBe('10px');
      expect(tools.style.top).toBe('590px');
    } finally {
      f.close();
    }
  });
  it.each([false, true])('拖动后重新挂载恢复位置与吸附状态：%s', (dockAgain) => {
    const f = mount(true);
    const storage = f.storage;
    try {
      const button = document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!;
      pointer(button, 'pointerdown', 32, 610);
      pointer(button, 'pointermove', 430, 300);
      pointer(button, 'pointerup', 430, 300);
      if (dockAgain) {
        pointer(button, 'pointerdown', 430, 300);
        pointer(button, 'pointermove', 32, 610);
        pointer(button, 'pointerup', 32, 610);
      }
      expect(storage.getItem('weq:tools-docked')).toBe(String(dockAgain));
    } finally {
      f.close();
    }
    const restored = mount(undefined, storage);
    try {
      const tools = document.querySelector<HTMLElement>('.weq-floating-tools')!;
      const position = JSON.parse(storage.getItem('weq:tools-position')!);
      expect(tools.classList.contains('is-docked')).toBe(dockAgain);
      expect(tools.style.left).toBe(`${dockAgain ? 10 : position.x}px`);
      expect(tools.style.top).toBe(`${dockAgain ? 590 : position.y}px`);
    } finally {
      restored.close();
    }
  });
  it.each([false, true])('停靠图标与快捷控制同尺寸，浮动时保留原尺寸：%s', (docked) => {
    const f = mount(docked);
    try {
      const icon = document.querySelector('.weq-tools-trigger .lucide-wrench')!;
      expect(icon.getAttribute('width')).toBe(docked ? '18' : '22');
      expect(f.host.querySelector('.weq-rail-utility-toggle.weq-rail-control')).not.toBeNull();
    } finally {
      f.close();
    }
  });
  it('图标与提示区分自动折叠和固定展开', () => {
    const f = mount();
    try {
      const toggle = f.host.querySelector<HTMLButtonElement>('[aria-label="快捷控制"]')!;
      expect(toggle.querySelector('.lucide-sliders-horizontal')).not.toBeNull();
      expect(toggle.title).toContain('自动折叠');
      act(() => toggle.click());
      expect(toggle.querySelector('.lucide-pin')).not.toBeNull();
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(toggle.title).toContain('固定展开');
      act(() => toggle.click());
      expect(toggle.querySelector('.lucide-sliders-horizontal')).not.toBeNull();
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
    } finally {
      f.close();
    }
  });
  it('固定展开不因窗口失焦、移出或外部点击丢失，只响应显式切换', () => {
    const f = mount();
    try {
      const utilities = f.host.querySelector<HTMLElement>('.weq-rail-utilities')!;
      const toggle = f.host.querySelector<HTMLButtonElement>('[aria-label="快捷控制"]')!;
      act(() => toggle.click());
      const child = utilities.querySelector<HTMLButtonElement>('.weq-rail-utility-actions button')!;
      act(() => child.focus());
      act(() =>
        child.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })),
      );
      act(() => window.dispatchEvent(new Event('blur')));
      pointer(utilities, 'pointerout', 300, 300);
      pointer(document.body, 'pointerdown', 300, 300);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      act(() => toggle.click());
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
    } finally {
      f.close();
    }
  });
  it.each([false, true])('设置打开时隐藏工具入口，关闭后恢复位置与停靠状态：%s', (docked) => {
    const f = mount(docked);
    try {
      const render = (hidden: boolean) =>
        act(() =>
          f.root.render(
            createElement(
              'div',
              null,
              createElement(RailUtilityDock, null, createElement('button', null, '主题')),
              createElement(FloatingToolsBar, {
                hidden,
                items: [{ id: 'export', label: '导出', icon: null, action: vi.fn() }],
              }),
            ),
          ),
        );
      const original = document.querySelector<HTMLElement>('.weq-floating-tools')!;
      const position = original.style.cssText;
      act(() => original.querySelector<HTMLButtonElement>('.weq-tools-trigger')!.click());
      render(true);
      expect(document.querySelector<HTMLElement>('.weq-floating-tools')?.hidden).toBe(true);
      expect(document.querySelector('[role="toolbar"]')).toBeNull();
      render(false);
      const restored = document.querySelector<HTMLElement>('.weq-floating-tools')!;
      expect(restored.hidden).toBe(false);
      expect(restored.style.cssText).toBe(position);
      expect(restored.classList.contains('is-docked')).toBe(docked);
    } finally {
      f.close();
    }
  });
  it('四个操作默认不可聚焦，悬停临时展开，点击固定，再次点击或 Escape 收起', () => {
    vi.useFakeTimers();
    const f = mount();
    try {
      const utilities = f.host.querySelector<HTMLElement>('.weq-rail-utilities')!;
      const actions = f.host.querySelector<HTMLElement>('.weq-rail-utility-actions')!;
      const toggle = f.host.querySelector<HTMLButtonElement>('[aria-label="快捷控制"]')!;
      expect(actions.hasAttribute('inert')).toBe(true);
      pointer(toggle, 'pointerover', 20, 650);
      act(() => vi.advanceTimersByTime(499));
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      act(() => vi.advanceTimersByTime(1));
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      pointer(utilities, 'pointerout', 120, 650);
      act(() => vi.advanceTimersByTime(999));
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      act(() => vi.advanceTimersByTime(1));
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      act(() => toggle.click());
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      act(() => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      act(() => toggle.click());
      act(() =>
        toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(actions.hasAttribute('inert')).toBe(true);
    } finally {
      f.close();
    }
  });

  it('吸附判定仅接受可见槽位附近的落点', () => {
    const rect = { left: 10, top: 590, width: 44, height: 44 };
    expect(floatingDockHit({ x: 32, y: 610 }, rect)).toBe(true);
    expect(floatingDockHit({ x: 300, y: 610 }, rect)).toBe(false);
    expect(floatingDockHit({ x: 32, y: 610 }, { ...rect, width: 0 })).toBe(false);
    expect(floatingDockHit({ x: 32, y: 610 }, null)).toBe(false);
  });

  it('快捷控制移出后等待 1s，途中进入菜单会取消收起并重新计算连续离开时间', () => {
    vi.useFakeTimers();
    const f = mount();
    try {
      const utilities = f.host.querySelector<HTMLElement>('.weq-rail-utilities')!;
      const toggle = f.host.querySelector<HTMLButtonElement>('[aria-label="快捷控制"]')!;
      const menu = f.host.querySelector<HTMLElement>('.weq-rail-utility-actions')!;
      vi.spyOn(utilities, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 500, 46, 160));
      pointer(toggle, 'pointerover', 32, 620);
      act(() => vi.advanceTimersByTime(500));
      pointer(utilities, 'pointerout', 32, 496);
      act(() => vi.advanceTimersByTime(700));
      expect(utilities.classList.contains('is-expanded')).toBe(true);
      pointer(menu, 'pointerover', 32, 520);
      act(() => vi.advanceTimersByTime(700));
      expect(utilities.classList.contains('is-expanded')).toBe(true);
      pointer(menu, 'pointerout', 160, 494);
      act(() => vi.advanceTimersByTime(999));
      expect(utilities.classList.contains('is-expanded')).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(utilities.classList.contains('is-expanded')).toBe(false);
    } finally {
      f.close();
    }
  });

  it('短暂经过快捷控制不展开，重新进入需重新等待 500ms', () => {
    vi.useFakeTimers();
    const f = mount();
    try {
      const utilities = f.host.querySelector<HTMLElement>('.weq-rail-utilities')!;
      const toggle = f.host.querySelector<HTMLButtonElement>('[aria-label="快捷控制"]')!;
      pointer(toggle, 'pointerover', 20, 650);
      act(() => vi.advanceTimersByTime(300));
      pointer(toggle, 'pointerout', 300, 300);
      act(() => vi.advanceTimersByTime(500));
      expect(utilities.classList.contains('is-expanded')).toBe(false);
      pointer(toggle, 'pointerover', 20, 650);
      act(() => vi.advanceTimersByTime(499));
      expect(utilities.classList.contains('is-expanded')).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(utilities.classList.contains('is-expanded')).toBe(true);
    } finally {
      f.close();
    }
  });

  it('快捷控制在 500ms 内从按钮移到同一容器空白处也会取消展开', () => {
    vi.useFakeTimers();
    const f = mount();
    try {
      const toggle = f.host.querySelector<HTMLButtonElement>('[aria-label="快捷控制"]')!;
      const utilities = f.host.querySelector<HTMLElement>('.weq-rail-utilities')!;
      pointer(toggle, 'pointerover', 20, 650);
      act(() => vi.advanceTimersByTime(300));
      act(() =>
        toggle.dispatchEvent(
          new PointerEvent('pointerout', { bubbles: true, relatedTarget: utilities }),
        ),
      );
      act(() => vi.advanceTimersByTime(1000));
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    } finally {
      f.close();
    }
  });

  it('工具菜单连续移出 1s 后收起，进入按钮或菜单均重新计算离开时间', () => {
    vi.useFakeTimers();
    const f = mount();
    try {
      const button = document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!;
      pointer(button, 'pointerover', 900, 600);
      act(() => vi.advanceTimersByTime(500));
      pointer(button, 'pointerout', 500, 300);
      act(() => vi.advanceTimersByTime(700));
      const menu = document.querySelector('[role="toolbar"]')!;
      pointer(menu, 'pointerover', 850, 550);
      act(() => vi.advanceTimersByTime(700));
      expect(button.getAttribute('aria-expanded')).toBe('true');
      pointer(menu, 'pointerout', 500, 300);
      act(() => vi.advanceTimersByTime(700));
      pointer(button, 'pointerover', 900, 600);
      act(() => vi.advanceTimersByTime(700));
      expect(button.getAttribute('aria-expanded')).toBe('true');
      pointer(button, 'pointerout', 500, 300);
      act(() => vi.advanceTimersByTime(999));
      expect(button.getAttribute('aria-expanded')).toBe('true');
      act(() => vi.advanceTimersByTime(1));
      expect(button.getAttribute('aria-expanded')).toBe('false');
    } finally {
      f.close();
    }
  });

  it.each([false, true])('工具悬停 500ms 展开，拖拽中取消等待并收起：%s', (docked) => {
    vi.useFakeTimers();
    const f = mount(docked);
    try {
      const button = document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!;
      pointer(button, 'pointerover', 900, 600);
      act(() => vi.advanceTimersByTime(499));
      expect(button.getAttribute('aria-expanded')).toBe('false');
      act(() => vi.advanceTimersByTime(1));
      expect(button.getAttribute('aria-expanded')).toBe('true');
      pointer(button, 'pointerdown', 900, 600);
      pointer(button, 'pointermove', 430, 300);
      act(() => vi.advanceTimersByTime(1000));
      expect(button.getAttribute('aria-expanded')).toBe('false');
      pointer(button, 'pointerup', 430, 300);
      pointer(button, 'pointerout', 300, 300);
      pointer(button, 'pointerover', 430, 300);
      act(() => vi.advanceTimersByTime(300));
      pointer(button, 'pointerdown', 430, 300);
      pointer(button, 'pointermove', 450, 300);
      act(() => vi.advanceTimersByTime(1000));
      expect(button.getAttribute('aria-expanded')).toBe('false');
    } finally {
      f.close();
    }
  });

  it('工具短暂悬停或等待期间隐藏时不展开，卸载时清理等待', () => {
    vi.useFakeTimers();
    const f = mount();
    try {
      const button = document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!;
      pointer(button, 'pointerover', 900, 600);
      act(() => vi.advanceTimersByTime(300));
      pointer(button, 'pointerout', 500, 300);
      act(() => vi.advanceTimersByTime(500));
      expect(button.getAttribute('aria-expanded')).toBe('false');
      pointer(button, 'pointerover', 900, 600);
      act(() => f.root.render(createElement(FloatingToolsBar, { items: [], hidden: true })));
      act(() => vi.advanceTimersByTime(500));
      expect(document.querySelector('[role="toolbar"]')).toBeNull();
      act(() => f.root.render(createElement(FloatingToolsBar, { items: [] })));
      pointer(document.querySelector('.weq-tools-trigger')!, 'pointerover', 900, 600);
    } finally {
      f.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('拖至槽位后按槽位坐标停靠，保留顶层 DOM 并持久化，不误打开工具条', () => {
    const f = mount();
    try {
      const button = document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!;
      pointer(button, 'pointerdown', 900, 600);
      pointer(button, 'pointermove', 32, 610);
      expect(f.slot.classList.contains('is-drop-target')).toBe(true);
      pointer(button, 'pointerup', 32, 610);
      const docked = document.querySelector<HTMLElement>('.weq-floating-tools.is-docked')!;
      expect(docked.parentElement).toBe(document.body);
      expect(docked.style.left).toBe('10px');
      expect(docked.style.top).toBe('590px');
      expect(f.storage.getItem('weq:tools-docked')).toBe('true');
      expect(document.querySelector('[role="toolbar"]')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('恢复停靠偏好，并能从停靠位置拖出恢复浮动', () => {
    const f = mount(true);
    try {
      const button = document.querySelector<HTMLButtonElement>('.weq-tools-trigger')!;
      expect(button).not.toBeNull();
      pointer(button, 'pointerdown', 32, 610);
      pointer(button, 'pointermove', 430, 300);
      expect(button.parentElement?.parentElement).toBe(document.body);
      pointer(button, 'pointerup', 430, 300);
      expect(f.slot.querySelector('.weq-floating-tools')).toBeNull();
      expect(document.querySelector('.weq-floating-tools:not(.is-docked)')).not.toBeNull();
      expect(document.querySelector('.weq-floating-tools:not(.is-docked)')?.parentElement).toBe(
        document.body,
      );
      expect(f.storage.getItem('weq:tools-docked')).toBe('false');
      expect(JSON.parse(f.storage.getItem('weq:tools-position')!).x).toBeGreaterThan(100);
    } finally {
      f.close();
    }
  });
});
