import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { cloneRequests } from './browser/clone-conversation.stub';
import { GroupChatPanel } from '../src/renderer/src/views/agentlab/GroupChatPanel';
import { GroupInfoPanel } from '../src/renderer/src/im-template/template/groupInfoPanel';
import {
  cloneChatConversation,
  cloneChatUser,
} from '../src/renderer/src/views/agentlab/cloneChatAdapter';

vi.mock('../src/renderer/src/trpc/client', () => import('./browser/clone-conversation.stub'));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm, error: vi.fn() }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('克隆群复用普通群资料栏，支持折叠与本地成员搜索，不显示未实现的 QQ 内容入口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(GroupChatPanel, {
          groupId: 'g',
          sessionId: 's',
          selfUin: '10000',
          personaList: [{ id: 'p', name: '合成好友', sourceId: 'source', sourceUin: '20001' }],
          profileByUid: new Map(),
          faceDescToId: new Map(),
          onBack: vi.fn(),
          onDeleted: vi.fn(),
          onSessionCreated: vi.fn(),
          onSwitchSession: vi.fn(),
          onNewSession: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector('.chat-pane.with-group-info')).not.toBeNull();
    expect(host.querySelectorAll('.group-info-member-row')).toHaveLength(2);
    const cloneRow = [...host.querySelectorAll('.group-info-member-row')].find((row) =>
      row.textContent?.includes('合成好友'),
    )!;
    expect(cloneRow.textContent).not.toContain('克隆体');
    expect(cloneRow.querySelector('[aria-label="克隆体"]')).not.toBeNull();
    const selfRow = [...host.querySelectorAll('.group-info-member-row')].find((row) =>
      row.textContent?.includes('我'),
    )!;
    expect(selfRow.textContent).not.toContain('克隆体');
    expect(host.querySelector('.weq-group-content-actions')).toBeNull();
    expect(host.querySelector('.weq-group-announcement')).toBeNull();
    expect(host.querySelector('.group-info-left-members-button')).toBeNull();
    const search = host.querySelector<HTMLInputElement>('[aria-label="搜索群成员"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(search, '合成好友');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('.group-info-member-row')).toHaveLength(1);
    expect(host.querySelector('.group-info-member-row')?.textContent).toContain('合成好友');
    await act(async () => {
      setValue.call(search, '不存在的成员');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('.group-info-member-row')).toHaveLength(0);
    expect(host.querySelector('.group-info-member-empty')?.textContent).toBe('没有匹配的成员');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="清除搜索"]')!.click());
    expect(host.querySelectorAll('.group-info-member-row')).toHaveLength(2);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="添加成员"]')!.click());
    const picker = document.querySelector<HTMLElement>('.weq-clone-add-modal')!;
    expect(picker.querySelector<HTMLInputElement>('[aria-label="合成好友"]')!.checked).toBe(true);
    expect(picker.querySelector<HTMLInputElement>('[aria-label="合成好友"]')!.disabled).toBe(true);
    act(() => picker.querySelector<HTMLButtonElement>('[aria-label="关闭添加成员"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起群资料"]')!.click());
    expect(host.querySelector('.chat-pane.group-info-collapsed')).not.toBeNull();
    expect(host.querySelector('.group-info-panel')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="展开群资料"]')!.click());
    expect(host.querySelector('.group-info-panel')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('虚拟群成员没有 QQ 号仍显示并支持键盘打开名片，普通群占位成员继续过滤', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const peer = cloneChatUser('missing-source', '没有源资料的克隆体', undefined, true);
  const conversation = cloneChatConversation({
    target: { kind: 'group', ownerId: 'g', sessionId: null },
    viewId: 'virtual:clone:g',
    name: '克隆群',
    peer,
    members: [peer],
  });
  if (conversation.type !== 'group') throw new Error('预期群聊');
  const open = vi.fn();
  try {
    act(() => root.render(h(GroupInfoPanel, { conversation, onOpenMember: open })));
    const row = host.querySelector<HTMLElement>('.group-info-member-row')!;
    expect(row).not.toBeNull();
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })));
    expect(open).toHaveBeenCalledWith(conversation.members[0], expect.any(Object));
    act(() =>
      root.render(
        h(GroupInfoPanel, {
          conversation: { ...conversation, generated: undefined },
          onOpenMember: open,
        }),
      ),
    );
    expect(host.querySelector('.group-info-member-row')).toBeNull();
    expect(host.querySelector('[aria-label="添加成员"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('克隆群成员右键复用普通菜单，支持提及与确认移除，不执行真实 QQ 操作', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cloneRequests.length = 0;
  confirm.mockClear();
  const props = {
    groupId: 'g',
    sessionId: 's',
    selfUin: '10000',
    personaList: [{ id: 'p', name: '合成好友', sourceId: 'source', sourceUin: '20001' }],
    profileByUid: new Map(),
    faceDescToId: new Map(),
    onBack: vi.fn(),
    onDeleted: vi.fn(),
    onSessionCreated: vi.fn(),
    onSwitchSession: vi.fn(),
    onNewSession: vi.fn(),
  };
  const openMenu = async (name: string) => {
    const row = [...host.querySelectorAll('.group-info-member-row')].find((item) =>
      item.textContent?.includes(name),
    )!;
    await act(async () =>
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      ),
    );
    return [...host.querySelectorAll<HTMLButtonElement>('.avatar-context-menu button')];
  };
  try {
    await act(async () => root.render(h(GroupChatPanel, props)));
    act(() => host.querySelector<HTMLButtonElement>('.weq-mobile-group-info-trigger')!.click());
    let buttons = await openMenu('合成好友');
    act(() =>
      host
        .querySelector('.group-info-member-row')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(host.querySelector('.avatar-context-menu')).toBeNull();
    expect(host.querySelector('.chat-pane.is-mobile-group-info-open')).not.toBeNull();
    buttons = await openMenu('合成好友');
    expect(buttons.find((item) => item.textContent === '戳一戳')?.disabled).toBe(true);
    expect(
      buttons.some((item) =>
        ['分析此成员', '设置禁言', '设为管理员', '修改群昵称'].includes(item.textContent ?? ''),
      ),
    ).toBe(false);
    act(() => buttons.find((item) => item.textContent === '@Ta')!.click());
    expect(host.querySelector('.composer-editor')?.textContent).toContain('@合成好友');
    confirm.mockResolvedValueOnce(false);
    buttons = await openMenu('合成好友');
    await act(async () => buttons.find((item) => item.textContent === '踢出群聊')!.click());
    expect(cloneRequests).toHaveLength(0);
    buttons = await openMenu('我');
    expect(buttons.some((item) => item.textContent === '踢出群聊')).toBe(false);
    await act(async () => root.render(h(GroupChatPanel, { ...props, readOnlyLegacy: true })));
    buttons = await openMenu('合成好友');
    expect(buttons.find((item) => item.textContent === '踢出群聊')?.disabled).toBe(true);
    await act(async () => root.render(h(GroupChatPanel, props)));
    confirm.mockResolvedValueOnce(true);
    buttons = await openMenu('合成好友');
    await act(async () => buttons.find((item) => item.textContent === '踢出群聊')!.click());
    expect(confirm).toHaveBeenCalledWith(
      '移除成员',
      expect.stringContaining('不会删除克隆体或私聊记录'),
      expect.any(Object),
    );
    expect(cloneRequests).toEqual([
      { name: 'removeAgentLabGroupMember', input: { groupId: 'g', memberId: 'p' } },
    ]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
