import { act, createElement as h, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMenuWorkspace } from '../src/renderer/src/views/agentlab/AssistantMenuWorkspace';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import type { AssistantActivity } from '../src/renderer/src/lib/workspaceIndicators';
import {
  readAssistantDraft,
  readAssistantSession,
  rememberAssistantDraft,
  rememberAssistantSession,
} from '../src/renderer/src/lib/assistantWorkspace';

const fixture = vi.hoisted(() => ({
  sessions: [
    { id: 'chosen', title: '主动选择的会话', updatedAt: 1 },
    { id: 'background', title: '后台更新的会话', updatedAt: 999999 },
  ],
  mounts: 0,
  created: null as null | (() => void),
  activity: new Map<string, (activity: AssistantActivity, result?: string) => void>(),
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: async () => true, error: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { listAssistantSessions: { invalidate: vi.fn() } } }),
    bootstrap: { listAgentLabProviders: { useQuery: () => ({ data: [] }) } },
    account: {
      listAssistantSessions: {
        useQuery: () => ({ data: fixture.sessions, isSuccess: true, isFetching: false }),
      },
      deleteAssistantSession: {
        useMutation: () => ({ mutateAsync: async () => {}, isLoading: false }),
      },
    },
  },
}));
vi.mock('../src/renderer/src/views/agentlab/AssistantPanel', () => ({
  AssistantPanel: ({
    sessionId,
    onSessionCreated,
    onActivityChange,
  }: {
    sessionId: string | null;
    onSessionCreated: (id: string) => void;
    onActivityChange: (activity: AssistantActivity, result?: string) => void;
  }) => {
    const [draft, setDraft] = useState('');
    useEffect(() => {
      fixture.mounts++;
    }, []);
    if (!sessionId) fixture.created = () => onSessionCreated('created');
    fixture.activity.set(sessionId ?? 'new', onActivityChange);
    return h(
      'div',
      { 'data-session': sessionId ?? 'new' },
      h('input', { value: draft, onChange: (event) => setDraft(event.currentTarget.value) }),
    );
  },
}));

beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  fixture.mounts = 0;
  fixture.created = null;
  fixture.activity.clear();
  useWorkspaceMenu.getState().setAssistant('idle');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('菜单助手会话', () => {
  it('会话结果已读跨卸载恢复，不清除新回答或其他账号的提醒', () => {
    rememberAssistantSession('persist-assistant', 'chosen');
    const host = document.createElement('div');
    let root = createRoot(host);
    const render = (active: boolean, accountScope = 'persist-assistant') =>
      act(() =>
        root.render(
          h(TabActivity, { active }, h(AssistantMenuWorkspace, { accountScope, compact: true })),
        ),
      );
    try {
      render(true);
      act(() => fixture.activity.get('chosen')!('finished', 'result-a'));
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(false);
      act(() => root.unmount());
      root = createRoot(host);
      render(false);
      act(() => fixture.activity.get('chosen')!('finished', 'result-a'));
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(false);
      act(() => fixture.activity.get('chosen')!('finished', 'result-b'));
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(true);
      render(true);
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(false);
      act(() => fixture.activity.get('chosen')!('running'));
      act(() => root.unmount());
      root = createRoot(host);
      render(false);
      act(() => fixture.activity.get('chosen')!('finished', 'result-b'));
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(true);
      act(() => root.unmount());
      rememberAssistantSession('other-account', 'chosen');
      root = createRoot(host);
      render(false, 'other-account');
      act(() => fixture.activity.get('chosen')!('finished', 'result-a'));
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it('窗口隐藏期间完成不算已读，回来查看后清红点，下一轮仍保留蓝点', () => {
    let hidden = false;
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    rememberAssistantSession('window-activity', 'chosen');
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(h(AssistantMenuWorkspace, { accountScope: 'window-activity', compact: true })),
      );
      act(() => fixture.activity.get('chosen')!('running'));
      expect(useWorkspaceMenu.getState().assistant).toBe('running');
      act(() => {
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      act(() => fixture.activity.get('chosen')!('finished'));
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(true);
      act(() => {
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(false);
      act(() => fixture.activity.get('chosen')!('running'));
      expect(useWorkspaceMenu.getState()).toMatchObject({
        assistant: 'running',
        assistantUnread: false,
      });
    } finally {
      act(() => root.unmount());
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('只统计当前选中的会话，菜单隐藏后仍更新，回到旧会话恢复对应状态', () => {
    rememberAssistantSession('activity', 'chosen');
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (active: boolean) =>
      act(() =>
        root.render(
          h(
            TabActivity,
            { active },
            h(AssistantMenuWorkspace, { accountScope: 'activity', compact: false }),
          ),
        ),
      );
    try {
      render(true);
      act(() => fixture.activity.get('chosen')!('running'));
      expect(useWorkspaceMenu.getState().assistant).toBe('running');
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(false);
      render(false);
      act(() => fixture.activity.get('chosen')!('finished'));
      expect(useWorkspaceMenu.getState().assistant).toBe('finished');
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(true);
      render(true);
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(false);
      render(false);
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(false);
      render(true);
      act(() =>
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '后台更新的会话')!
          .click(),
      );
      expect(useWorkspaceMenu.getState().assistant).toBe('idle');
      act(() => fixture.activity.get('chosen')!('running'));
      expect(useWorkspaceMenu.getState().assistant).toBe('idle');
      act(() => fixture.activity.get('background')!('finished'));
      expect(useWorkspaceMenu.getState().assistant).toBe('finished');
      expect(useWorkspaceMenu.getState().assistantUnread).toBe(false);
      act(() =>
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '主动选择的会话')!
          .click(),
      );
      expect(useWorkspaceMenu.getState().assistant).toBe('running');
    } finally {
      act(() => root.unmount());
    }
    expect(useWorkspaceMenu.getState().assistant).toBe('idle');
  });

  it('账号分别记忆，后台排序不改变主动选择，展开收起不重挂会话', () => {
    rememberAssistantSession('account-a/config-a', 'chosen');
    rememberAssistantSession('account-a/config-b', 'background');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(AssistantMenuWorkspace, { accountScope: 'account-a/config-a', compact: true }),
        ),
      );
      const input = host.querySelector<HTMLInputElement>('[data-session="chosen"] input')!;
      input.value = '尚未发送';
      act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
      act(() =>
        root.render(
          h(AssistantMenuWorkspace, { accountScope: 'account-a/config-a', compact: false }),
        ),
      );
      expect(host.querySelector('[data-session="chosen"] input')).toBe(input);
      expect(fixture.mounts).toBe(1);
      expect(readAssistantSession('account-a/config-b')).toBe('background');
      const background = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '后台更新的会话',
      )!;
      act(() => background.click());
      expect(readAssistantSession('account-a/config-a')).toBe('background');
      act(() =>
        root.render(
          h(AssistantMenuWorkspace, { accountScope: 'account-a/config-a', compact: true }),
        ),
      );
      expect(host.querySelector('[data-session="background"]')).not.toBeNull();
      expect(fixture.mounts).toBe(2);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('没有记忆或会话已删除时使用草稿，不自动接续最近更新的历史', () => {
    for (const remembered of [null, 'deleted']) {
      const mounts = fixture.mounts;
      rememberAssistantSession('account', remembered);
      const host = document.createElement('div');
      const root = createRoot(host);
      try {
        act(() =>
          root.render(h(AssistantMenuWorkspace, { accountScope: 'account', compact: true })),
        );
        expect(host.querySelector('[data-session="new"]')).not.toBeNull();
        expect(readAssistantSession('account')).toBeNull();
        expect(fixture.mounts).toBe(mounts + 1);
      } finally {
        act(() => root.unmount());
      }
    }
  });

  it('草稿在后台建好会话时不抢走后来主动选择的会话', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(h(AssistantMenuWorkspace, { accountScope: 'account', compact: false })),
      );
      const created = fixture.created!;
      act(() =>
        [...host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '主动选择的会话')!
          .click(),
      );
      act(created);
      expect(readAssistantSession('account')).toBe('chosen');
      expect(
        host
          .querySelector('[data-session="chosen"]')
          ?.closest('[data-retained-panel]')
          ?.hasAttribute('hidden'),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('输入草稿按账号及会话隔离，空稿移除存储，存储不可用不打断操作', () => {
    rememberAssistantDraft('account-a', null, '新草稿');
    rememberAssistantDraft('account-a', 'chosen', '历史会话草稿');
    expect(readAssistantDraft('account-b', null)).toBe('');
    expect(readAssistantDraft('account-a', null)).toBe('新草稿');
    expect(readAssistantDraft('account-a', 'chosen')).toBe('历史会话草稿');
    rememberAssistantDraft('account-a', null, '');
    expect(readAssistantDraft('account-a', null)).toBe('');
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    expect(() => rememberAssistantSession('account', 'chosen')).not.toThrow();
    expect(() => rememberAssistantDraft('account', null, '草稿')).not.toThrow();
    expect(readAssistantSession('account')).toBeNull();
    expect(readAssistantDraft('account', null)).toBe('');
  });
});
