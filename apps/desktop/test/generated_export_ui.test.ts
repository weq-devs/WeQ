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
  messages: ['a', 'b', 'c'].map((id) => ({
    id,
    role: 'user' as const,
    text: `合成正文${id}`,
    ts: 1,
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

it('生成对话的本次菜单沿用同一提交管线，先生成意图不写全局偏好', async () => {
  const prepare = vi.fn(async () => ({ mode: 'after' as const }));
  const f = mount(['a'], prepare);
  try {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click());
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (node) => node.textContent === '先生成，稍后保存',
    )!;
    await act(async () => button.click());
    expect(prepare).toHaveBeenCalledWith({ mode: 'after' });
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
