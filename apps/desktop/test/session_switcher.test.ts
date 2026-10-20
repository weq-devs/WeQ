/**
 * 克隆体 / 克隆群进入会话列表后，左栏没有了。
 *
 * 回归点：对话内部必须还有「新建 / 切换 / 删除会话」的入口，否则历史记录里
 * 能看到好几段对话却没有任何办法切换。
 */

import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionSwitcher } from '../src/renderer/src/views/agentlab/SessionSwitcher';

afterEach(() => {
  vi.unstubAllGlobals();
});

const sessions = [
  { id: 's1', title: '最近一段', createdAt: 1, updatedAt: Date.now() },
  { id: 's2', title: '更早一段', createdAt: 1, updatedAt: Date.now() - 86400_000 },
];

function mount(props: Partial<Parameters<typeof SessionSwitcher>[0]> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handlers = {
    onSwitch: vi.fn(),
    onNew: vi.fn(),
    onDelete: vi.fn(),
  };
  act(() =>
    root.render(
      h(SessionSwitcher, {
        sessions,
        activeSessionId: 's1',
        draft: false,
        ...handlers,
        ...props,
      }),
    ),
  );
  return {
    host,
    handlers,
    trigger: () => host.querySelector<HTMLButtonElement>('[aria-label="切换会话"]')!,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('触发器显示当前会话标题与数量，展开后能切换、新建、删除', () => {
  const f = mount();
  try {
    expect(f.trigger().textContent).toContain('最近一段');
    expect(f.trigger().textContent).toContain('2');
    expect(f.host.querySelector('[role="menu"]')).toBeNull();
    act(() => f.trigger().click());
    expect(f.host.querySelector('[role="menu"]')).not.toBeNull();
    // 当前会话在列表里带勾选标记。
    expect(f.host.querySelector('.weq-session-switcher-row.is-active')?.textContent).toContain(
      '最近一段',
    );
    const items = [...f.host.querySelectorAll<HTMLButtonElement>('.weq-session-switcher-open')];
    expect(items).toHaveLength(2);
    act(() => items[1]!.click());
    expect(f.handlers.onSwitch).toHaveBeenCalledWith('s2');
    // 选完自动收起。
    expect(f.host.querySelector('[role="menu"]')).toBeNull();
    act(() => f.trigger().click());
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-session-switcher-new')!.click());
    expect(f.handlers.onNew).toHaveBeenCalledOnce();
    act(() => f.trigger().click());
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="删除会话 更早一段"]')!.click());
    expect(f.handlers.onDelete).toHaveBeenCalledWith('s2');
  } finally {
    f.close();
  }
});

it('草稿态显示「新会话」，没有会话时给出提示，只读时禁用触发器', () => {
  const f = mount({ draft: true, activeSessionId: null, sessions: [] });
  try {
    expect(f.trigger().textContent).toContain('新会话');
    act(() => f.trigger().click());
    expect(f.host.textContent).toContain('还没有会话');
    act(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(f.host.querySelector('[role="menu"]')).toBeNull();
  } finally {
    f.close();
  }
  const disabled = mount({ disabled: true });
  try {
    expect(disabled.trigger().disabled).toBe(true);
  } finally {
    disabled.close();
  }
});
