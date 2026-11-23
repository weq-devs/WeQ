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
    model: { providerId: 'synthetic', model: 'model-a' } as AgentLabModelSelection | undefined,
    reasoningEffort: 'medium',
  },
  save: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  utils: {
    account: {
      getAssistantConversation: { invalidate: vi.fn() },
      getAssistantConfig: { invalidate: vi.fn(), setData: vi.fn() },
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => fixture.utils,
    bootstrap: {
      getDevelopmentFeatures: { useQuery: () => ({ data: { dressTools: false } }) },
      getSettings: { useQuery: () => ({ data: undefined }) },
      listAgentLabProviders: {
        useQuery: () => ({
          data: [
            {
              id: 'synthetic',
              name: '合成提供方',
              models: [
                { id: 'model-a', capabilities: ['chat'] },
                { id: 'model-b', capabilities: ['chat'] },
              ],
            },
          ],
        }),
      },
      synthesizeSpeech: { useMutation: () => ({ mutateAsync: vi.fn(), isLoading: false }) },
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
          if (
            [
              'dressup',
              'emojiPanel',
              'sysEmoji',
              'roamingBackfill',
              'qqWrite',
              'qqActions',
              'intentSense',
            ].includes(String(path))
          )
            return new Proxy(
              {},
              {
                get: () => ({
                  useQuery: () => ({ data: undefined }),
                  useMutation: () => ({ mutate: vi.fn(), isLoading: false }),
                }),
              },
            );
          return {
            useQuery: () => ({
              data:
                path === 'getAssistantConfig'
                  ? fixture.config
                  : path === 'getAssistantConversation'
                    ? fixture.conversation
                    : undefined,
              isSuccess: true,
            }),
            useMutation: () => ({ mutateAsync: fixture.save, isLoading: false }),
          };
        },
      },
    ),
  },
  client: { account: { onAssistantEvent: { subscribe: fixture.subscribe } } },
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
vi.mock('../src/renderer/src/views/agentlab/messageSearch.shared', () => ({
  GeneratedSearchNotice: () => null,
  useGeneratedSearchJump: () => false,
}));

beforeEach(() => {
  fixture.config.model = { providerId: 'synthetic', model: 'model-a' };
  fixture.save
    .mockReset()
    .mockImplementation(async (patch) => Object.assign(fixture.config, patch));
  fixture.unsubscribe.mockReset();
  fixture.subscribe.mockReset().mockImplementation(() => ({ unsubscribe: fixture.unsubscribe }));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => vi.unstubAllGlobals());

it('无界面控制器释放聊天 DOM 与 ResizeObserver，保留后台订阅和输入数据', () => {
  const targets = new Set<Element>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private owned = new Set<Element>();
      observe(element: Element) {
        this.owned.add(element);
        targets.add(element);
      }
      disconnect() {
        for (const element of this.owned) targets.delete(element);
        this.owned.clear();
      }
    },
  );
  rememberAssistantDraft('synthetic/config', null, '等待继续编辑');
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = {
    sessionId: null,
    chatModels: [],
    draftAccount: 'synthetic/config',
    onBack: vi.fn(),
    onSessionCreated: vi.fn(),
  };
  try {
    act(() => root.render(h(AssistantPanel, props)));
    const input = host.querySelector('.composer-editor');
    expect(targets.size).toBeGreaterThan(0);
    act(() => root.render(h(AssistantPanel, { ...props, headless: true })));
    expect(host.querySelector('*')).toBeNull();
    expect(targets.size).toBe(0);
    expect(fixture.subscribe).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
    act(() => root.render(h(AssistantPanel, props)));
    expect(host.querySelector('.composer-editor')).not.toBe(input);
    expect(host.querySelector('.composer-editor')!.textContent).toBe('等待继续编辑');
    expect(targets.size).toBeGreaterThan(0);
  } finally {
    act(() => root.unmount());
  }
  expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  expect(targets.size).toBe(0);
});

it('未发送的新助手会话可覆盖模型并恢复继承，不写应用设置', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = { sessionId: null, chatModels: [], onBack: vi.fn(), onSessionCreated: vi.fn() };
  try {
    act(() => root.render(h(AssistantPanel, props)));
    const model = host.querySelector<HTMLButtonElement>('[aria-label^="本会话模型"]')!;
    expect(model.textContent).toBe('model-a');
    const choose = (label: string) => {
      act(() => model.click());
      act(() =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
          .find((item) => item.textContent?.startsWith(label))!
          .click(),
      );
    };
    choose('model-b');
    expect(model.textContent).toBe('model-b');
    act(() => root.render(h(AssistantPanel, { ...props, compact: true })));
    expect(model.textContent).toBe('model-b');
    choose('跟随默认');
    expect(model.textContent).toBe('model-a');
    expect(fixture.save).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

it('助手没有单独指定模型时直接选中默认，没有未选择项', () => {
  fixture.config.model = undefined;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(AssistantPanel, {
          sessionId: null,
          chatModels: [],
          onBack: vi.fn(),
          onSessionCreated: vi.fn(),
        }),
      ),
    );
    const model = host.querySelector<HTMLButtonElement>('[aria-label^="本会话模型"]')!;
    expect(model.textContent).toBe('model-b');
  } finally {
    act(() => root.unmount());
  }
});

it('紧凑与完整助手共用聊天工具和草稿，切换不重建编辑器', () => {
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
    expect(host.querySelector('.chat-header')?.textContent).toContain('合成会话');
    expect(host.querySelector('[aria-label^="本会话模型"]')).not.toBeNull();
    expect(host.querySelector('[aria-label^="本会话思考强度"]')).not.toBeNull();
    const input = host.querySelector('.composer-editor')!;
    expect(input.textContent).toBe('保留的草稿');
    act(() => root.render(h(AssistantPanel, { ...props, compact: false })));
    expect(host.querySelector('.composer-editor')).toBe(input);
    expect(input.textContent).toBe('保留的草稿');
    expect(host.querySelector('[aria-label^="本会话模型"]')).not.toBeNull();
    expect(host.querySelector('[aria-label^="本会话思考强度"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
