/**
 * 统一会话视图后，「切换 / 新建 / 删除助手会话」的入口从标题栏的 SessionSwitcher
 * 浮层变成工作区内的会话侧栏（AssistantMenuWorkspace 的 aside[aria-label="助手会话"]）。
 *
 * 回归点不变：进到对话里必须还能切别的会话、开新会话、删旧会话，否则历史记录
 * 在左侧列表里有好几段却没有任何办法操作。
 */

import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantMenuWorkspace } from '../src/renderer/src/views/agentlab/AssistantMenuWorkspace';
import { readAssistantSession } from '../src/renderer/src/lib/assistantWorkspace';

const fixture = vi.hoisted(() => ({
  sessions: [
    { id: 's1', title: '最近一段', createdAt: 1, updatedAt: 2000 },
    { id: 's2', title: '更早一段', createdAt: 1, updatedAt: 1000 },
  ],
  remove: vi.fn(async () => undefined),
  invalidate: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
  error: vi.fn(),
}));

vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: fixture.confirm, error: fixture.error, success: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { listAssistantSessions: { invalidate: fixture.invalidate } } }),
    bootstrap: { listAgentLabProviders: { useQuery: () => ({ data: [] }) } },
    account: {
      listAssistantSessions: {
        useQuery: () => ({ data: fixture.sessions, isSuccess: true, isFetching: false }),
      },
      deleteAssistantSession: {
        useMutation: () => ({ mutateAsync: fixture.remove, isLoading: false }),
      },
    },
  },
}));
vi.mock('../src/renderer/src/views/agentlab/AssistantPanel', () => ({
  AssistantPanel: ({
    sessionId,
    workspaceTitle,
  }: {
    sessionId: string | null;
    workspaceTitle?: string;
  }) =>
    h('div', { 'data-session': sessionId ?? 'new' }, h('strong', null, workspaceTitle ?? '新会话')),
}));

beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.confirm.mockClear().mockResolvedValue(true);
  fixture.error.mockClear();
  fixture.remove.mockClear();
  fixture.invalidate.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(accountScope = 'switch-fixture') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (compact = false) =>
    act(() => root.render(h(AssistantMenuWorkspace, { accountScope, compact }), null));
  render();
  const aside = () => host.querySelector<HTMLElement>('aside[aria-label="助手会话"]');
  const row = (title: string) =>
    [...(aside()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.querySelector('span')?.textContent === title,
    );
  return {
    host,
    render,
    aside,
    row,
    session: () => host.querySelector('[data-session]')?.getAttribute('data-session'),
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('侧栏展示会话并在当前会话上标记，切换、新建、删除都能用', async () => {
  localStorage.setItem('weq:assistant:switch-fixture:selected', 's1');
  const f = mount();
  try {
    const aside = f.aside()!;
    expect(aside.querySelectorAll('.weq-assistant-session-row')).toHaveLength(2);
    // 当前会话在列表里带 aria-current 标记。
    expect(f.row('最近一段')?.getAttribute('aria-current')).toBe('true');
    expect(f.row('更早一段')?.getAttribute('aria-current')).toBeNull();
    expect(f.session()).toBe('s1');

    act(() => f.row('更早一段')!.click());
    expect(f.session()).toBe('s2');
    expect(readAssistantSession('switch-fixture')).toBe('s2');
    expect(f.row('更早一段')?.getAttribute('aria-current')).toBe('true');

    act(() =>
      [...f.aside()!.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('新建会话'))!
        .click(),
    );
    expect(f.session()).toBe('new');
    expect(readAssistantSession('switch-fixture')).toBeNull();

    // 删除先要确认，确认后才真的删，并刷新会话列表。
    await act(async () =>
      f.row('更早一段')!.parentElement!.querySelector('button[title="删除会话"]')!.click(),
    );
    expect(fixture.confirm).toHaveBeenCalledOnce();
    expect(fixture.remove).toHaveBeenCalledWith({ sessionId: 's2' });
    expect(fixture.invalidate).toHaveBeenCalledOnce();
    expect(fixture.error).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('取消删除不请求后端；窄屏收起侧栏但保留当前会话', async () => {
  localStorage.setItem('weq:assistant:switch-fixture:selected', 's2');
  fixture.confirm.mockResolvedValue(false);
  const f = mount();
  try {
    await act(async () =>
      f.row('更早一段')!.parentElement!.querySelector('button[title="删除会话"]')!.click(),
    );
    expect(fixture.confirm).toHaveBeenCalledOnce();
    expect(fixture.remove).not.toHaveBeenCalled();

    // compact 只是隐藏侧栏，当前选中会话不变。
    f.render(true);
    expect(f.aside()?.hidden).toBe(true);
    expect(f.session()).toBe('s2');
  } finally {
    f.close();
  }
});
