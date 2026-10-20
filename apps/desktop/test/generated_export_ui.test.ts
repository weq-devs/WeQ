import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GeneratedExportPane } from '../src/renderer/src/views/export/GeneratedExportPane';
import {
  generatedContentContainer,
  generatedContentIdentity,
} from '../src/shared/content_selection';
import { initialExportMode } from '../src/renderer/src/views/export/exportScope';

const fixture = vi.hoisted(() => ({
  start: vi.fn(async (_input: unknown) => 'task'),
  targets: [
    {
      kind: 'persona' as const,
      ownerId: 'p:1',
      sessionId: 's:1',
      title: '合成克隆',
      sessionTitle: '私聊',
      count: 3,
    },
    {
      kind: 'assistant' as const,
      ownerId: 'assistant',
      sessionId: 's:1',
      title: 'WeQ 助手',
      sessionTitle: '助手会话',
      count: 3,
    },
  ],
  messages: ['a', 'b', 'c'].map((id, index) => ({
    id,
    // 一半「我」、一半克隆体：两侧气泡都要有头像。
    role: index === 1 ? ('assistant' as const) : ('user' as const),
    text: `合成正文${id}`,
    ts: 1 + index * 1000,
  })),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: {
        useQuery: () => ({ data: { uin: '10001', configId: 'fixture-config' } }),
      },
      generatedConversations: {
        useQuery: () => ({ data: fixture.targets, isError: false, isLoading: false }),
      },
      generatedConversation: {
        useQuery: () => ({
          data: { messages: fixture.messages },
          isError: false,
          isFetching: false,
        }),
      },
      getAgentLabGroupDetail: {
        useQuery: () => ({ data: null, isLoading: false, isError: false }),
      },
      listAgentLabPersonas: {
        useQuery: () => ({
          data: [{ id: 'p:1', name: '合成克隆', sourceUin: '20001', sourceId: 'u_p1' }],
          isLoading: false,
        }),
      },
      listAgentLabGroups: { useQuery: () => ({ data: [], isLoading: false }) },
      getSelfProfile: { useQuery: () => ({ data: { uin: '', nick: '合成我' } }) },
    },
  },
  client: { account: { startGeneratedExport: { mutate: fixture.start } } },
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function mount(
  ids: string[] = ['a', 'c'],
  prepareSave = async () => ({ mode: 'after' as const }),
  isCurrent = () => true,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const selection = {
    owner: {
      kind: 'clone-messages' as const,
      container: generatedContentContainer(fixture.targets[0]!),
    },
    scope: { type: 'items' as const, ids },
  };
  const started = vi.fn();
  act(() =>
    root.render(
      createElement(GeneratedExportPane, {
        initialSelection: selection,
        prepareSave,
        isCurrent,
        onStarted: started,
      }),
    ),
  );
  return {
    host,
    selection,
    started,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('会话列表与对话气泡都显示克隆体源好友头像，不再回落成默认小人', async () => {
  const f = mount(['a'], async () => ({ mode: 'after' as const }));
  try {
    await act(async () => {});
    // 会话列表行：每个 clone 会话一个头像，且用的是源好友的 QQ 号。
    const rows = [...f.host.querySelectorAll<HTMLElement>('.weq-generated-export-row.is-session')];
    expect(rows.length).toBeGreaterThan(0);
    const sessionImg = rows[0]!.querySelector<HTMLImageElement>('.weq-generated-export-avatar img');
    expect(sessionImg?.getAttribute('src')).toContain('20001');
    // 助手会话用渐变星芒图标，而不是 QQ 头像的灰色小人回落。
    const assistantRow = rows.find((row) => row.textContent?.includes('WeQ 助手'))!;
    expect(
      assistantRow.querySelector('.weq-generated-export-avatar-fb.is-assistant'),
    ).not.toBeNull();
    // 对话气泡：克隆体（非「我」）那条也带头像。
    const bubbles = f.host.querySelectorAll('.weq-generated-export-bubble .message-line.theirs');
    expect(bubbles.length).toBeGreaterThan(0);
    expect(bubbles[0]!.querySelector('.avatar img')?.getAttribute('src')).toContain('20001');
  } finally {
    f.close();
  }
});
it('生成对话的本次菜单沿用同一提交管线，先生成意图不写全局偏好', async () => {
  const prepare = vi.fn(async () => ({ mode: 'after' as const }));
  const f = mount(['a'], prepare);
  try {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click());
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (node) => node.textContent === '先生成，稍后保存',
    )!;
    await act(async () => button.click());
    expect(prepare).toHaveBeenCalledWith({ mode: 'after' }, { kind: 'bundle', name: '生成对话' });
    expect(fixture.start).toHaveBeenCalledWith(
      expect.objectContaining({ savePolicy: { mode: 'after' }, messageIds: ['a'] }),
    );
  } finally {
    f.close();
  }
});
it('生成目标用结构化身份区分同名会话、旧记录与助手，不靠分隔符猜测', () => {
  const target = { kind: 'persona' as const, ownerId: 'p:1', sessionId: 's:1' };
  const selection = {
    owner: { kind: 'clone-messages' as const, container: generatedContentContainer(target) },
    scope: { type: 'items' as const, ids: [] },
  };
  expect(initialExportMode(selection)).toBe('generated');
  expect(generatedContentIdentity(selection)).toEqual(target);
  expect(
    generatedContentIdentity({
      ...selection,
      owner: { ...selection.owner, kind: 'assistant-messages' },
    }),
  ).toBeNull();
  expect(
    generatedContentIdentity({ ...selection, owner: { ...selection.owner, container: 'p:1:s:1' } }),
  ).toBeNull();
  expect(
    generatedContentIdentity({
      ...selection,
      owner: {
        ...selection.owner,
        container: generatedContentContainer({ ...target, sessionId: null }),
      },
    })?.sessionId,
  ).toBeNull();
});
it('精确选择按原身份交给任务，等待保存时来源选择的外部变化不改写确认目标', async () => {
  let release!: (value: { mode: 'after' }) => void;
  const f = mount(
    ['a', 'c'],
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    expect(f.host.textContent).toContain('精确选中 2 条消息');
    await act(async () => f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.click());
    f.selection.scope.ids.push('b');
    expect(fixture.start).not.toHaveBeenCalled();
    await act(async () => release({ mode: 'after' }));
    expect(fixture.start).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'fixture-config',
        target: { kind: 'persona', ownerId: 'p:1', sessionId: 's:1' },
        messageIds: ['a', 'c'],
        formats: ['json'],
      }),
    );
    expect(f.started).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});
it.each([{ ids: [] as string[] }, { ids: ['missing'] }])(
  '空或缺失精确集合 $ids 不会变成整场对话',
  ({ ids }) => {
    const f = mount(ids);
    try {
      expect(f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.disabled).toBe(true);
    } finally {
      f.close();
    }
  },
);
it('切号后停止旧准备；各对话的精确草稿独立保留', async () => {
  const f = mount(
    ['a'],
    async () => ({ mode: 'after' }),
    () => false,
  );
  try {
    const sessions = f.host.querySelectorAll<HTMLButtonElement>(
      '.weq-generated-export-sessions button.weq-generated-export-row',
    );
    act(() => sessions[1]!.click());
    expect(f.host.textContent).toContain('整场持久对话');
    act(() => sessions[0]!.click());
    expect(f.host.textContent).toContain('精确选中 1 条消息');
    await act(async () => f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.click());
    expect(fixture.start).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('助手消息的气泡头像用星芒图标，不回落成灰头像', async () => {
  const original = fixture.targets;
  fixture.targets = [
    {
      kind: 'assistant' as const,
      ownerId: 'assistant',
      sessionId: 's:1',
      title: 'WeQ 助手',
      sessionTitle: '助手会话',
      count: 1,
    },
  ];
  // 助手会话里被问的那句是「我」，回的那句才是助手。
  fixture.messages = [
    { id: 'a', role: 'user' as const, text: '帮我查聊天', ts: 1 },
    { id: 'b', role: 'assistant' as const, text: '查到了', ts: 2_000 },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const target = fixture.targets[0]!;
    act(() =>
      root.render(
        createElement(GeneratedExportPane, {
          initialSelection: {
            // 助手会话的 owner kind 必须是 assistant-messages（校验会拒绝混用）。
            owner: { kind: 'assistant-messages', container: generatedContentContainer(target) },
            scope: { type: 'all' },
          },
          prepareSave: async () => null,
          isCurrent: () => true,
          onStarted: vi.fn(),
        }),
      ),
    );
    await act(async () => {});
    // 助手那条（非「我」）用星芒图标，而不是空 uin 的灰色小人。
    const theirs = host.querySelector('.weq-generated-export-bubble .message-line.theirs');
    expect(theirs?.querySelector('.weq-asst-avatar')).not.toBeNull();
    expect(theirs?.querySelector('.weq-avatar-fallback')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    fixture.targets = original;
    fixture.messages = ['a', 'b', 'c'].map((id, index) => ({
      id,
      role: index === 1 ? ('assistant' as const) : ('user' as const),
      text: `合成正文${id}`,
      ts: 1 + index * 1000,
    }));
  }
});
