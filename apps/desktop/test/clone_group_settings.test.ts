import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GroupChatPanel } from '../src/renderer/src/views/agentlab/GroupChatPanel';

const f = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  mutate: vi.fn(async (_name: string, _input: unknown) => true),
  invalidate: vi.fn(async () => {}),
  error: vi.fn(),
  empty: [],
  detail: {
    group: { name: '合成群' },
    members: [{ memberId: 'p', kind: 'persona', displayName: '合成成员' }],
  },
  sessions: [{ id: 's', title: '当前对话', createdAt: 1, updatedAt: 2 }],
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const endpoints = new Proxy(
    {},
    {
      get: (_, name) => ({
        useQuery: () => ({
          data:
            name === 'getAgentLabGroupDetail'
              ? f.detail
              : name === 'listAgentLabGroupSessions'
                ? f.sessions
                : f.empty,
          isLoading: false,
        }),
        useMutation: () => ({
          mutateAsync: (input: unknown) => f.mutate(String(name), input),
          isLoading: false,
        }),
      }),
    },
  );
  return {
    trpc: {
      account: endpoints,
      useUtils: () => ({ account: new Proxy({}, { get: () => ({ invalidate: f.invalidate }) }) }),
    },
    client: { account: { onGroupChatEvent: { subscribe: () => ({ unsubscribe: vi.fn() }) } } },
  };
});
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: f.confirm, error: f.error }),
}));
vi.mock('../src/renderer/src/im-template/template/chatPane', () => ({
  ChatPane: ({
    headerActions,
    onOpenConversationSettings,
    onAddGroupMember,
  }: {
    headerActions: ReactNode;
    onOpenConversationSettings: () => void;
    onAddGroupMember?: () => void;
  }) =>
    h(
      'div',
      null,
      h('button', { onClick: onOpenConversationSettings }, '群设置'),
      h('button', { onClick: onAddGroupMember }, '侧栏添加成员'),
      headerActions,
    ),
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  f.confirm.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

function fixture(sessionId: string | null = 's') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const memberSettings = vi.fn();
  const deleted = vi.fn();
  const newSession = vi.fn();
  act(() =>
    root.render(
      h(GroupChatPanel, {
        groupId: 'g',
        sessionId,
        personaList: [
          { id: 'p', name: '合成成员', sourceId: 'u_fixture' },
          { id: 'outside', name: '待加入成员', sourceId: 'u_outside' },
        ],
        profileByUid: new Map(),
        faceDescToId: new Map(),
        onBack: vi.fn(),
        onDeleted: deleted,
        onSessionCreated: vi.fn(),
        onSwitchSession: vi.fn(),
        onNewSession: newSession,
        onOpenPersonaSettings: memberSettings,
      }),
    ),
  );
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === text,
    )!;
  return {
    host,
    memberSettings,
    deleted,
    newSession,
    button,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('群设置只管理成员和整个群；成员设置指向克隆体，删除整个群不删除克隆体', async () => {
  const t = fixture();
  try {
    act(() => t.button('群设置').click());
    const pane = document.querySelector<HTMLElement>('.weq-conversation-settings-pane')!;
    expect(t.button('清空聊天记录')).toBeUndefined();
    act(() => pane.querySelector<HTMLButtonElement>('[title="设置克隆体 合成成员"]')!.click());
    expect(t.memberSettings).toHaveBeenCalledWith('p');
    act(() => t.button('群聊管理').click());
    expect(pane.textContent).toContain('全部历史对话');
    expect(pane.textContent).toContain('不会删除成员对应的克隆体');
    f.confirm.mockResolvedValueOnce(false);
    await act(async () => t.button('删除整个群聊').click());
    expect(f.mutate).not.toHaveBeenCalled();
    await act(async () => t.button('删除整个群聊').click());
    expect(f.mutate).toHaveBeenCalledOnce();
    expect(f.mutate).toHaveBeenCalledWith('deleteAgentLabGroup', { groupId: 'g' });
    expect(t.deleted).toHaveBeenCalledOnce();
  } finally {
    t.dispose();
  }
});

it('历史菜单清空仅提交当前群对话的身份，取消时不写库', async () => {
  const t = fixture();
  try {
    const open = () =>
      act(() => t.host.querySelector<HTMLButtonElement>('[aria-label="切换会话"]')!.click());
    open();
    f.confirm.mockResolvedValueOnce(false);
    await act(async () => t.button('清空当前对话').click());
    expect(f.mutate).not.toHaveBeenCalled();
    open();
    await act(async () => t.button('清空当前对话').click());
    expect(f.mutate).toHaveBeenCalledOnce();
    expect(f.mutate).toHaveBeenCalledWith('clearAgentLabGroupConversation', {
      groupId: 'g',
      sessionId: 's',
    });
    expect(t.newSession).not.toHaveBeenCalled();
    expect(t.deleted).not.toHaveBeenCalled();
  } finally {
    t.dispose();
  }
});

it('未保存的新草稿不显示清空当前对话，避免误触旧会话', () => {
  const t = fixture(null);
  try {
    act(() => t.host.querySelector<HTMLButtonElement>('[aria-label="切换会话"]')!.click());
    expect(t.button('清空当前对话')).toBeUndefined();
    expect(f.mutate).not.toHaveBeenCalled();
  } finally {
    t.dispose();
  }
});

it('侧栏添加直接打开成员候选，可搜索且排除已入群克隆体，失败保留候选供重试', async () => {
  const t = fixture();
  try {
    act(() => t.button('侧栏添加成员').click());
    const pane = document.querySelector<HTMLElement>('.weq-conversation-settings-pane')!;
    expect(pane).not.toBeNull();
    const picker = pane.querySelector<HTMLElement>('[aria-label="可添加的克隆体"]')!;
    expect(picker).not.toBeNull();
    expect(picker.textContent).toContain('待加入成员');
    expect(picker.textContent).not.toContain('合成成员');
    const input = picker.querySelector<HTMLInputElement>('[aria-label="搜索可添加的克隆体"]')!;
    const change = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    change('不存在');
    expect(picker.textContent).toContain('没有匹配的克隆体');
    change('待加入');
    const add = () => picker.querySelector<HTMLButtonElement>('[title="添加 待加入成员"]')!;
    f.mutate.mockRejectedValueOnce(new Error('合成失败'));
    await act(async () => add().click());
    expect(f.error).toHaveBeenCalledWith('添加失败', '合成失败');
    expect(add().disabled).toBe(false);
    await act(async () => add().click());
    expect(f.mutate).toHaveBeenLastCalledWith('addAgentLabGroupMember', {
      groupId: 'g',
      personaId: 'outside',
    });
    expect(f.invalidate).toHaveBeenCalled();
  } finally {
    t.dispose();
  }
});

it('添加后等待成员列表刷新期间不允许重复提交', async () => {
  const t = fixture();
  let finish: () => void = () => {};
  try {
    act(() => t.button('侧栏添加成员').click());
    const add = document.querySelector<HTMLButtonElement>('[title="添加 待加入成员"]')!;
    f.invalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => add.click());
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('aria-busy')).toBe('true');
    act(() => add.click());
    expect(f.mutate).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(add.disabled).toBe(false);
  } finally {
    finish();
    t.dispose();
  }
});
