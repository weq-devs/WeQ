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
  f.mutate.mockResolvedValue(true);
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
          { id: 'second', name: '另一位成员', sourceId: 'u_second' },
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

it('独立添加弹窗默认勾选并禁用已入群成员，搜索保留选择，确认前不写库且失败可重试', async () => {
  const t = fixture();
  try {
    act(() => t.button('侧栏添加成员').click());
    expect(document.querySelector('.weq-conversation-settings-pane')).toBeNull();
    const picker = document.querySelector<HTMLElement>('.weq-clone-add-modal')!;
    expect(picker).not.toBeNull();
    const existing = picker.querySelector<HTMLInputElement>('[aria-label="合成成员"]')!;
    expect(existing.checked).toBe(true);
    expect(existing.disabled).toBe(true);
    const candidate = () => picker.querySelector<HTMLInputElement>('[aria-label="待加入成员"]')!;
    expect(candidate().checked).toBe(false);
    const input = picker.querySelector<HTMLInputElement>('[aria-label="搜索克隆体"]')!;
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
    act(() => candidate().click());
    change('');
    expect(candidate().checked).toBe(true);
    expect(f.mutate).not.toHaveBeenCalled();
    f.mutate.mockRejectedValueOnce(new Error('合成失败'));
    await act(async () => t.button('添加（1）').click());
    expect(picker.querySelector('[role="alert"]')?.textContent).toContain('合成失败');
    expect(candidate().checked).toBe(true);
    expect(t.button('添加（1）').disabled).toBe(false);
    await act(async () => t.button('添加（1）').click());
    expect(f.mutate).toHaveBeenLastCalledWith('addAgentLabGroupMember', {
      groupId: 'g',
      personaId: 'outside',
    });
    expect(f.invalidate).toHaveBeenCalled();
    expect(document.querySelector('.weq-clone-add-modal')).toBeNull();
  } finally {
    t.dispose();
  }
});

it('添加后等待成员列表刷新期间不允许重复提交', async () => {
  const t = fixture();
  let finish: () => void = () => {};
  try {
    act(() => t.button('侧栏添加成员').click());
    act(() => document.querySelector<HTMLInputElement>('[aria-label="待加入成员"]')!.click());
    f.invalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => t.button('添加（1）').click());
    expect(t.button('添加中…').disabled).toBe(true);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭添加成员"]')!.click());
    expect(document.querySelector('.weq-clone-add-modal')).not.toBeNull();
    act(() => t.button('添加中…').click());
    expect(f.mutate).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(document.querySelector('.weq-clone-add-modal')).toBeNull();
  } finally {
    finish();
    t.dispose();
  }
});

it('批量部分成功后成功项变成已勾选禁用，重试只添加剩余成员', async () => {
  const t = fixture();
  try {
    act(() => t.button('侧栏添加成员').click());
    const checkbox = (name: string) =>
      document.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
    act(() => {
      checkbox('待加入成员').click();
      checkbox('另一位成员').click();
    });
    f.mutate.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('第二位失败'));
    await act(async () => t.button('添加（2）').click());
    expect(checkbox('待加入成员').checked).toBe(true);
    expect(checkbox('待加入成员').disabled).toBe(true);
    expect(checkbox('另一位成员').checked).toBe(true);
    expect(checkbox('另一位成员').disabled).toBe(false);
    await act(async () => t.button('添加（1）').click());
    expect(f.mutate).toHaveBeenCalledTimes(3);
    expect(f.mutate).toHaveBeenLastCalledWith('addAgentLabGroupMember', {
      groupId: 'g',
      personaId: 'second',
    });
    expect(document.querySelector('.weq-clone-add-modal')).toBeNull();
  } finally {
    t.dispose();
  }
});

it('从成员设置进入独立弹窗，取消不修改群并返回原成员设置', () => {
  const t = fixture();
  try {
    act(() => t.button('群设置').click());
    act(() => t.button('添加成员').click());
    expect(document.querySelector('.weq-conversation-settings-pane')).toBeNull();
    act(() => document.querySelector<HTMLInputElement>('[aria-label="待加入成员"]')!.click());
    act(() => t.button('取消').click());
    expect(f.mutate).not.toHaveBeenCalled();
    expect(document.querySelector('.weq-conversation-settings-pane')).not.toBeNull();
    act(() => t.button('添加成员').click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="待加入成员"]')!.checked).toBe(
      false,
    );
  } finally {
    t.dispose();
  }
});
