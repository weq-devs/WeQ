import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionSwitcher } from '../src/renderer/src/views/agentlab/SessionSwitcher';

afterEach(() => vi.unstubAllGlobals());
it('会话选择脱离标题栏的裁切和层叠上下文，通过统一浮层显示并正确处理菜单点击', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  host.style.cssText = 'overflow:hidden;transform:translateZ(0);position:relative;z-index:1';
  const root = createRoot(host);
  const open = vi.fn();
  const remove = vi.fn();
  const clear = vi.fn();
  try {
    act(() =>
      root.render(
        h(SessionSwitcher, {
          compact: true,
          sessions: [{ id: 's', title: '合成会话', createdAt: 1, updatedAt: 1 }],
          activeSessionId: 's',
          draft: false,
          onNew: vi.fn(),
          onSwitch: open,
          onDelete: remove,
          onClear: clear,
        }),
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="切换会话"]')!.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="会话列表"]')!;
    expect(menu).not.toBeNull();
    expect(host.contains(menu)).toBe(false);
    expect(menu.closest('.weq-overlay-layer')?.parentElement).toBe(document.body);
    act(() =>
      [...menu.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '清空当前对话')!
        .click(),
    );
    expect(clear).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"][aria-label="会话列表"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="切换会话"]')!.click());
    const reopened = document.querySelector<HTMLElement>('[role="menu"][aria-label="会话列表"]')!;
    act(() =>
      reopened.querySelector<HTMLButtonElement>('[aria-label="删除会话 合成会话"]')!.click(),
    );
    expect(remove).toHaveBeenCalledWith('s');
    act(() => reopened.querySelector<HTMLButtonElement>('.weq-session-switcher-open')!.click());
    expect(open).toHaveBeenCalledWith('s');
    expect(document.querySelector('[role="menu"][aria-label="会话列表"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
