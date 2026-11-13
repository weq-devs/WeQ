/**
 * 会话选择不再从标题栏弹浮层：统一会话视图把「助手会话」做成工作区内的侧栏，
 * 和对话区并列排版。这样它天然不受标题栏的 overflow 裁切和层叠上下文影响，
 * 也不需要 portal 到 overlay 层后再追着锚点定位。
 *
 * 回归点：侧栏必须留在工作区内（和对话区同一层），切会话后没有残留浮层。
 */

import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantMenuWorkspace } from '../src/renderer/src/views/agentlab/AssistantMenuWorkspace';

const fixture = vi.hoisted(() => ({
  sessions: [
    { id: 's1', title: '合成会话一', createdAt: 1, updatedAt: 2000 },
    { id: 's2', title: '合成会话二', createdAt: 1, updatedAt: 1000 },
  ],
  remove: vi.fn(async () => undefined),
}));

vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: async () => true, error: vi.fn(), success: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { listAssistantSessions: { invalidate: async () => undefined } } }),
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
  AssistantPanel: ({ sessionId }: { sessionId: string | null }) =>
    h('div', { 'data-session': sessionId ?? 'new' }),
}));

beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.remove.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

it('会话侧栏留在工作区内并列排版，不受标题栏裁切和浮层影响', () => {
  const host = document.createElement('div');
  document.body.append(host);
  // 模拟旧的裁剪现场：祖先有 overflow:hidden + transform 层叠上下文。
  host.style.cssText = 'overflow:hidden;transform:translateZ(0);position:relative;z-index:1';
  const root = createRoot(host);
  try {
    act(() =>
      root.render(h(AssistantMenuWorkspace, { accountScope: 'layer-fixture', compact: false })),
    );
    const workspace = host.querySelector('.weq-assistant-workspace')!;
    const aside = host.querySelector<HTMLElement>('aside[aria-label="助手会话"]')!;
    expect(aside).not.toBeNull();
    // 侧栏是工作区的直接子节点，和对话区同级；不是 portal 到 body 的浮层。
    expect(aside.closest('.weq-assistant-workspace')).toBe(workspace);
    expect(aside.nextElementSibling?.classList.contains('weq-assistant-conversation')).toBe(true);
    expect(host.contains(aside)).toBe(true);
    expect(document.body.querySelector(':scope > .weq-assistant-workspace')).toBeNull();
    expect(aside.closest('.weq-overlay-layer')).toBeNull();
    expect(aside.closest('[role="menu"]')).toBeNull();

    // 切换会话只更新对话区，不产生浮层/遮罩。
    act(() =>
      [...aside.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.querySelector('span')?.textContent === '合成会话二')!
        .click(),
    );
    expect(host.querySelector('[data-session]')?.getAttribute('data-session')).toBe('s2');
    const conversation = workspace.querySelector('.weq-assistant-conversation')!;
    expect(conversation.querySelector('[data-session="s2"]')).not.toBeNull();
    expect(workspace.querySelector('.weq-overlay-layer')).toBeNull();
    // 全局只有这一个侧栏实例，没有另开一份浮层副本。
    expect(document.querySelectorAll('.weq-assistant-sessions')).toHaveLength(1);
    expect(document.querySelector('.weq-assistant-sessions')).toBe(aside);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
