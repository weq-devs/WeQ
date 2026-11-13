import { act, createElement as h, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantConversationPane } from '../src/renderer/src/views/agentlab/AssistantConversationPane';
import type { AssistantActivity } from '../src/renderer/src/lib/workspaceIndicators';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import {
  isAssistantSessionDeleted,
  markAssistantSessionDeleted,
} from '../src/renderer/src/lib/assistantWorkspace';

const fixture = vi.hoisted(() => ({
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
  deletedAtUnmount: new Map<string, boolean>(),
  sessions: [
    { id: 'first', title: '第一段独立对话' },
    { id: 'second', title: '第二段独立对话' },
  ],
  callbacks: new Map<
    string,
    {
      activity: (next: AssistantActivity, result?: string) => void;
      created: (id: string) => void;
    }
  >(),
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: { listAgentLabProviders: { useQuery: () => ({ data: [] }) } },
    account: {
      listAssistantSessions: {
        useQuery: () => ({
          data: fixture.sessions,
          isSuccess: true,
          isFetching: false,
        }),
      },
    },
  },
}));

vi.mock('../src/renderer/src/views/agentlab/AssistantPanel', () => ({
  AssistantPanel: ({
    sessionId,
    headless,
    workspaceTitle,
    onSessionCreated,
    onActivityChange,
    draftAccount,
  }: {
    sessionId: string | null;
    headless: boolean;
    workspaceTitle: string;
    onSessionCreated: (id: string) => void;
    onActivityChange: (activity: AssistantActivity, result?: string) => void;
    draftAccount?: string;
  }) => {
    const id = sessionId ?? 'draft';
    const mountedId = useRef(id).current;
    useEffect(() => {
      fixture.mounts.set(mountedId, (fixture.mounts.get(mountedId) ?? 0) + 1);
      return () => {
        fixture.unmounts.set(mountedId, (fixture.unmounts.get(mountedId) ?? 0) + 1);
        fixture.deletedAtUnmount.set(
          mountedId,
          isAssistantSessionDeleted(draftAccount ?? '', mountedId),
        );
      };
    }, [mountedId, draftAccount]);
    fixture.callbacks.set(id, { activity: onActivityChange, created: onSessionCreated });
    return headless ? null : h('div', { 'data-session-id': id }, workspaceTitle);
  },
}));

beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.mounts.clear();
  fixture.unmounts.clear();
  fixture.deletedAtUnmount.clear();
  fixture.sessions = [
    { id: 'first', title: '第一段独立对话' },
    { id: 'second', title: '第二段独立对话' },
  ];
  fixture.callbacks.clear();
  useWorkspaceMenu.getState().setAssistant('idle');
});
afterEach(() => vi.unstubAllGlobals());

describe('主聊天区域助手', () => {
  it('只切换可见聊天，后台生成保留订阅宿主，完成后释放非当前控制器', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (sessionId: string, active = true) =>
      act(() =>
        root.render(h(AssistantConversationPane, { accountScope: 'synthetic', sessionId, active })),
      );
    try {
      render('first');
      expect(host.textContent).toBe('第一段独立对话');
      act(() => fixture.callbacks.get('first')!.activity('running'));
      render('second');
      expect(host.querySelector('[data-session-id="first"]')).toBeNull();
      expect(host.querySelector('[data-session-id="second"]')).not.toBeNull();
      expect(fixture.unmounts.get('first')).toBeUndefined();
      expect(useWorkspaceMenu.getState().assistant).toBe('running');
      render('second', false);
      expect(host.querySelector('[data-session-id]')).toBeNull();
      expect(fixture.unmounts.get('second')).toBeUndefined();
      render('first');
      expect(fixture.mounts.get('first')).toBe(1);
      render('second');
      act(() => fixture.callbacks.get('first')!.activity('finished', 'first-result'));
      expect(fixture.unmounts.get('first')).toBe(1);
      expect(host.querySelector('[data-session-id="second"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('草稿升级不重新挂载，后台创建完成不抢走已选中的其他会话', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const created = vi.fn();
    const render = (sessionId: string | null) =>
      act(() =>
        root.render(
          h(AssistantConversationPane, {
            accountScope: 'synthetic',
            sessionId,
            onSessionCreated: created,
          }),
        ),
      );
    try {
      render(null);
      act(() => fixture.callbacks.get('draft')!.created('first'));
      expect(created).toHaveBeenCalledWith('first');
      render('first');
      expect(fixture.mounts.get('draft')).toBe(1);
      expect(fixture.mounts.get('first')).toBeUndefined();
      expect(fixture.unmounts.get('draft')).toBeUndefined();
      render(null);
      const callback = fixture.callbacks.get('draft')!;
      act(() => callback.activity('running'));
      render('second');
      created.mockClear();
      act(() => callback.created('background-created'));
      expect(created).not.toHaveBeenCalled();
      expect(host.querySelector('[data-session-id="second"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('账号切换重建控制器，不能把前一个账号的会话与运行带到新账号', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(AssistantConversationPane, { accountScope: 'account-a', sessionId: 'first' }),
        ),
      );
      act(() => fixture.callbacks.get('first')!.activity('running'));
      act(() =>
        root.render(
          h(AssistantConversationPane, { accountScope: 'account-b', sessionId: 'second' }),
        ),
      );
      expect(fixture.unmounts.get('first')).toBe(1);
      expect(host.querySelector('[data-session-id="first"]')).toBeNull();
      expect(host.querySelector('[data-session-id="second"]')).not.toBeNull();
      expect(useWorkspaceMenu.getState().assistant).toBe('idle');
    } finally {
      act(() => root.unmount());
    }
  });

  it('删除先登记再卸载对应控制器，旧搜索命中不能重开，其他生成不受影响', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const accountScope = 'pane-delete-current';
    const created = vi.fn();
    const deleted = ['first'];
    const render = (sessionId: string, removed: readonly string[] = []) =>
      act(() =>
        root.render(
          h(AssistantConversationPane, {
            accountScope,
            sessionId,
            deletedSessionIds: removed,
            onSessionCreated: created,
            searchTarget:
              sessionId === 'first' && removed.length
                ? {
                    category: 'assistantMessage',
                    kind: 'assistant',
                    ownerId: 'assistant',
                    sessionId: 'first',
                    messageId: 'old',
                    title: '旧结果',
                    sessionTitle: '旧结果',
                    content: '',
                    ts: 1,
                  }
                : undefined,
          }),
        ),
      );
    try {
      render('first');
      act(() => fixture.callbacks.get('first')!.activity('running'));
      const stale = fixture.callbacks.get('first')!;
      render('second');
      act(() => fixture.callbacks.get('second')!.activity('running'));
      render('second', deleted);
      expect(fixture.unmounts.get('first')).toBe(1);
      expect(fixture.deletedAtUnmount.get('first')).toBe(true);
      expect(fixture.unmounts.get('second')).toBeUndefined();
      expect(useWorkspaceMenu.getState().assistant).toBe('running');
      render('first', deleted);
      expect(host.textContent).toContain('已永久删除');
      expect(host.querySelector('[data-session-id]')).toBeNull();
      expect(fixture.mounts.get('first')).toBe(1);
      act(() => stale.created('first'));
      expect(created).not.toHaveBeenCalled();
      expect(fixture.unmounts.get('second')).toBeUndefined();
    } finally {
      act(() => root.unmount());
    }
  });

  it('已经登记删除的目标首次挂载也不创建面板，且账号之间的同名id互不影响', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    markAssistantSessionDeleted('pane-deleted-before-open', 'first');
    try {
      act(() =>
        root.render(
          h(AssistantConversationPane, {
            accountScope: 'pane-deleted-before-open',
            sessionId: 'first',
          }),
        ),
      );
      expect(host.textContent).toContain('已永久删除');
      expect(fixture.mounts.get('first')).toBeUndefined();
      act(() =>
        root.render(
          h(AssistantConversationPane, { accountScope: 'pane-other-account', sessionId: 'first' }),
        ),
      );
      expect(host.querySelector('[data-session-id="first"]')).not.toBeNull();
      expect(fixture.mounts.get('first')).toBe(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('其他端删除已打开会话后，已完成目录快照也精确移除对应缓存面板', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const props = { accountScope: 'pane-remote-deleted', sessionId: 'first' };
    try {
      act(() => root.render(h(AssistantConversationPane, props)));
      expect(host.querySelector('[data-session-id="first"]')).not.toBeNull();
      fixture.sessions = fixture.sessions.filter((session) => session.id !== 'first');
      act(() => root.render(h(AssistantConversationPane, props)));
      expect(host.textContent).toContain('已永久删除');
      expect(fixture.deletedAtUnmount.get('first')).toBe(true);
      expect(fixture.mounts.get('first')).toBe(1);
    } finally {
      act(() => root.unmount());
    }
  });
});
