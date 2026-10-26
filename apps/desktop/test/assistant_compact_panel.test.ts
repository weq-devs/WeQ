import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import type { AgentLabModelSelection } from '@weq/agentlab';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../src/renderer/src/views/agentlab/AssistantPanel';
import { rememberAssistantDraft } from '../src/renderer/src/lib/assistantWorkspace';

const fixture = vi.hoisted(() => ({
  conversation: [],
  config: {
    model: { providerId: 'synthetic', model: 'model-a' } as AgentLabModelSelection,
    reasoningEffort: 'medium',
  },
  save: vi.fn(),
  utils: {
    account: {
      getAssistantConversation: { invalidate: vi.fn() },
      getAssistantConfig: { invalidate: vi.fn() },
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => fixture.utils,
    bootstrap: {
      getAgentLabDefaultModel: {
        useQuery: () => ({
          data: {
            ref: { providerId: 'synthetic', model: 'model-b' },
            available: true,
            error: null,
          },
        }),
      },
    },
    account: new Proxy(
      {},
      {
        get(_target, path) {
          return {
            useQuery: () => ({
              data:
                path === 'getAssistantConfig'
                  ? fixture.config
                  : path === 'getAssistantConversation'
                    ? fixture.conversation
                    : {},
              isSuccess: true,
            }),
            useMutation: () => ({ mutateAsync: fixture.save, isLoading: false }),
          };
        },
      },
    ),
  },
  client: { account: { onAssistantEvent: { subscribe: () => ({ unsubscribe: vi.fn() }) } } },
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ error: vi.fn(), confirm: vi.fn() }),
}));
vi.mock('../src/renderer/src/views/agentlab/useGeneratedSelection', () => ({
  useGeneratedSelection: () => ({
    control: null,
    rootProps: { ref: () => {} },
    itemProps: () => ({}),
    selected: () => false,
  }),
}));
vi.mock('../src/renderer/src/views/agentlab/messageSearch', () => ({
  GeneratedSearchNotice: () => null,
  useGeneratedSearchJump: () => false,
}));

beforeEach(() => {
  fixture.config.model = { providerId: 'synthetic', model: 'model-a' };
  fixture.save.mockReset().mockResolvedValue({});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => vi.unstubAllGlobals());

it('助手模型菜单显式保存默认标记，紧凑模式显示当前具体默认模型', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = { sessionId: null, chatModels: [], onBack: vi.fn(), onSessionCreated: vi.fn() };
  try {
    act(() => root.render(h(AssistantPanel, props)));
    act(() => host.querySelector<HTMLButtonElement>('[title="聊天模型"]')!.click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (button) => button.textContent?.includes('默认：model-b'),
    )!;
    expect(option).toBeDefined();
    await act(async () => option.click());
    expect(fixture.save).toHaveBeenCalledWith({ model: { useDefault: true } });
    fixture.config.model = { useDefault: true };
    act(() => root.render(h(AssistantPanel, { ...props, compact: true })));
    expect(host.querySelector('.weq-asst-menu-meta')?.textContent).toContain('默认：model-b');
  } finally {
    act(() => root.unmount());
  }
});

it('紧凑助手只显示小字上下文，无会话/模型/思考选择器和预设问题，展开后恢复完整控件且保留草稿', () => {
  rememberAssistantDraft('synthetic/config', null, '保留的草稿');
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = {
    sessionId: null,
    chatModels: [
      {
        key: 'synthetic::model-a',
        providerId: 'synthetic',
        model: 'model-a',
        label: '合成提供方 · 合成模型',
      },
    ],
    draftAccount: 'synthetic/config',
    workspaceTitle: '合成会话',
    onBack: vi.fn(),
    onSessionCreated: vi.fn(),
  };
  try {
    act(() => root.render(h(AssistantPanel, { ...props, compact: true })));
    const meta = host.querySelector('.weq-asst-menu-meta')!;
    expect(meta.textContent).toContain('合成会话');
    expect(meta.textContent).toContain('合成模型');
    expect(meta.querySelectorAll('span')).toHaveLength(3);
    expect(meta.querySelector('button, select')).toBeNull();
    expect(
      host.querySelector('.weq-asst-select, .weq-asst-presets, .weq-session-switcher'),
    ).toBeNull();
    const input = host.querySelector('textarea')!;
    expect(input.value).toBe('保留的草稿');
    expect(input.placeholder).toBe('发送消息…');
    act(() => root.render(h(AssistantPanel, { ...props, compact: false })));
    expect(host.querySelector('textarea')).toBe(input);
    expect(input.value).toBe('保留的草稿');
    expect(host.querySelectorAll('.weq-asst-select')).toHaveLength(2);
    expect(host.querySelector('.weq-asst-presets')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
