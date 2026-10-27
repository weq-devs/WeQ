import { readFileSync } from 'node:fs';
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentLabView } from '../src/renderer/src/views/AgentLabView';
import { useViewState } from '../src/renderer/src/state/view';
import { personaUpdatedAt } from '../src/renderer/src/views/agentlab/personaUpdatedAt';

const f = vi.hoisted(() => ({
  empty: [],
  persona: {
    id: 'synthetic-clone',
    name: '合成克隆',
    sourceId: 'u_synthetic',
    sourceTitle: '合成来源',
    sourceKind: 'c2c',
    models: { chat: { providerId: 'synthetic', model: 'synthetic-model' } },
    corpusMessageCount: 123,
    trainedAt: Date.UTC(2026, 9, 27, 1, 2),
    updatedAt: Date.UTC(2026, 9, 27, 8, 9),
  },
  confirm: vi.fn(async () => true),
  remove: vi.fn(async () => true),
  invalidate: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const list = [f.persona];
  const utils = { account: new Proxy({}, { get: () => ({ invalidate: f.invalidate }) }) };
  const endpoints = new Proxy(
    {},
    {
      get: (_, name) => ({
        useQuery: () => ({
          data:
            name === 'listAgentLabPersonas'
              ? list
              : name === 'getAgentLabPersonaDetail'
                ? null
                : f.empty,
          isLoading: false,
          isFetching: false,
          isSuccess: true,
        }),
        useMutation: () => ({
          mutateAsync: name === 'deleteAgentLabPersona' ? f.remove : vi.fn(),
          isLoading: false,
        }),
      }),
    },
  );
  return {
    trpc: { account: endpoints, bootstrap: endpoints, useUtils: () => utils },
    client: {
      account: {
        refreshAgentLabFromC2c: { mutate: f.refresh },
        onAgentLabBuildProgress: { subscribe: () => ({ unsubscribe: vi.fn() }) },
      },
    },
  };
});
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: f.confirm, success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/renderer/src/components/Dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/components/Dialog')>()),
  Modal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/views/agentlab/CloneChatPanel', () => ({
  CloneChatPanel: ({
    modelLabel,
    onOpenSettings,
  }: {
    modelLabel: string;
    onOpenSettings: () => void;
  }) =>
    h('div', null, h('small', null, modelLabel), h('button', { onClick: onOpenSettings }, '设置')),
}));
vi.mock('../src/renderer/src/components/settings/CloneGenerationPanel', () => ({
  CloneGenerationPanel: () => h('div', null, '模型与生成参数'),
}));
vi.mock('../src/renderer/src/views/agentlab/AssistantPanel', () => ({
  AssistantPanel: () => null,
}));
vi.mock('../src/renderer/src/views/agentlab/GroupChatPanel', () => ({
  GroupChatPanel: () => null,
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 27));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('实际克隆会话在样本数后显示画像时间，设置包含更新、删除及模型配置', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: 'synthetic-account' });
  const host = document.createElement('div');
  const root = createRoot(host);
  const back = vi.fn();
  try {
    await act(async () =>
      root.render(
        h(AgentLabView, {
          embedded: true,
          openTarget: { kind: 'persona', id: f.persona.id, revision: 1 },
          onBackToDirectory: back,
        }),
      ),
    );
    expect(host.textContent).toContain('样本 123 条 · 更新于 10-27 09:02');
    const button = (label: string) =>
      [
        ...host.querySelectorAll<HTMLButtonElement>('button'),
        ...document.querySelectorAll<HTMLButtonElement>('button'),
      ].find((item) => item.textContent === label)!;
    expect(button('删除克隆体')).toBeUndefined();
    act(() => button('设置').click());
    expect(button('更新画像')).toBeDefined();
    expect(button('删除克隆体')).toBeDefined();
    expect(document.querySelector('.weq-conversation-settings-pane')?.textContent).toContain(
      '模型与生成参数',
    );
    expect(document.querySelector('.weq-cvs-nav')?.textContent).toContain('克隆体设置');
    f.confirm.mockResolvedValueOnce(false);
    await act(async () => button('删除克隆体').click());
    expect(f.remove).not.toHaveBeenCalled();
    await act(async () => button('删除克隆体').click());
    expect(f.remove).toHaveBeenCalledWith({ personaId: f.persona.id });
    expect(back).toHaveBeenCalledOnce();
    expect(button('更新画像')).toBeUndefined();
  } finally {
    act(() => root.unmount());
    useViewState.setState({ openedUin: null });
  }
});

it('旧克隆回退已有更新时间，无效时间不显示错误日期', () => {
  const updatedAt = Date.UTC(2026, 9, 26, 18, 3);
  expect(personaUpdatedAt({ updatedAt })).toBe('10-27 02:03');
  expect(personaUpdatedAt({ updatedAt: 0 })).toBe('未知');
  expect(personaUpdatedAt({ updatedAt: Number.NaN })).toBe('未知');
});

it('聊天头部不再包含克隆体删除入口', () => {
  const source = readFileSync('src/renderer/src/views/agentlab/CloneChatPanel.tsx', 'utf8');
  expect(source.includes('onDeletePersona')).toBe(false);
});
