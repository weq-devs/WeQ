import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationList,
  ContactList,
} from '../src/renderer/src/im-template/template/conversationLists';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ConversationDirectoryContext,
  ContactDirectoryContext,
} from '../src/renderer/src/lib/conversationDirectory';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { QqArk } from '../src/renderer/src/components/ark/QqArk';
import { QqDynamic } from '../src/renderer/src/components/QqDynamic';
import { QzoneCardNavigationContext } from '../src/renderer/src/lib/qzoneNavigation';
import { GapMessagesModal } from '../src/renderer/src/components/compose/GapMessagesModal';
import { MemberProfileCard } from '../src/renderer/src/components/MemberProfileCard';
import { Modal } from '../src/renderer/src/components/Dialog';
import { WorkspaceContent, WorkspacePages } from '../src/renderer/src/components/WorkspacePages';
import type { Conversation } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render: (node: Parameters<typeof root.render>[0]) => act(() => root.render(node)),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function button(host: ParentNode, name: string) {
  const value =
    host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ??
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === name,
    );
  if (!value) throw new Error(`找不到按钮 ${name}`);
  return value;
}
describe('新增消息交互', () => {
  it('QQ 置顶组内按消息与草稿活动排序，不按执行置顶的先后固定位置', () => {
    const f = mount();
    const base = createTemplateDemoData().conversations[0]!;
    const pinned = (id: string, time: string, pinnedAt: number) => ({
      ...base,
      id,
      updatedAt: time,
      lastMessage: { id, senderId: null, body: id, createdAt: time },
      preference: { pinned: true },
      pinStateKnown: true,
      pinnedAt,
    });
    const earlierPin = pinned('early-pin', '2026-10-21T03:00:00Z', 100);
    const laterPin = pinned('late-pin', '2026-10-21T02:00:00Z', 200);
    const unpinned = {
      ...pinned('not-pinned', '2026-10-21T05:00:00Z', 300),
      preference: { pinned: false },
    };
    const render = (rows: Conversation[]) =>
      f.render(
        h(ConversationList, {
          conversations: rows,
          activeConversationId: null,
          // 已读回的 QQ 状态仍应胜过旧本地偏好。
          preferences: { 'early-pin': { pinned: false }, 'not-pinned': { pinned: true } },
          drafts: {},
          onSelect: vi.fn(),
        }),
      );
    const order = () =>
      [...f.host.querySelectorAll('[data-conversation-id]')].map((row) =>
        row.getAttribute('data-conversation-id'),
      );
    try {
      render([laterPin, unpinned, earlierPin]);
      expect(order()).toEqual(['early-pin', 'late-pin', 'not-pinned']);
      const message = { ...laterPin, updatedAt: '2026-10-21T04:00:00Z' };
      render([earlierPin, unpinned, message]);
      expect(order()).toEqual(['late-pin', 'early-pin', 'not-pinned']);
      render([
        message,
        { ...earlierPin, activityTime: Date.parse('2026-10-21T06:00:00Z') },
        unpinned,
      ]);
      expect(order()).toEqual(['early-pin', 'late-pin', 'not-pinned']);
      render([earlierPin, unpinned, message]);
      expect(order()).toEqual(['late-pin', 'early-pin', 'not-pinned']);
    } finally {
      f.close();
    }
  });

  it('会话活动变化即时调整行位置，草稿清除回落且置顶仍优先', () => {
    const f = mount();
    const base = createTemplateDemoData().conversations[0]!;
    const a = {
      ...base,
      id: 'sort-a',
      updatedAt: '2026-10-21T01:00:00Z',
      lastMessage: { id: 'a', senderId: null, body: 'a', createdAt: '2026-10-21T01:00:00Z' },
    };
    const b = { ...a, id: 'sort-b', updatedAt: '2026-10-21T02:00:00Z' };
    const render = (rows: (typeof a)[]) =>
      f.render(
        h(ConversationList, {
          conversations: rows,
          activeConversationId: null,
          preferences: {},
          drafts: {},
          onSelect: vi.fn(),
        }),
      );
    const order = () =>
      [...f.host.querySelectorAll('[data-conversation-id]')].map((row) =>
        row.getAttribute('data-conversation-id'),
      );
    try {
      render([a, b]);
      expect(order()).toEqual(['sort-b', 'sort-a']);
      render([{ ...a, activityTime: Date.parse('2026-10-21T03:00:00Z') }, b]);
      expect(order()).toEqual(['sort-a', 'sort-b']);
      render([a, b]);
      expect(order()).toEqual(['sort-b', 'sort-a']);
      render([
        { ...a, activityTime: Date.parse('2026-10-21T04:00:00Z') },
        { ...b, pinnedAt: 1, preference: { pinned: true } },
      ]);
      expect(order()).toEqual(['sort-b', 'sort-a']);
    } finally {
      f.close();
    }
  });
  it('私聊标题复用好友名片入口，并以标题下缘定位', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'direct')!;
    const onOpenGroupMember = vi.fn();
    try {
      fixture.render(
        h(ChatPane, {
          user: demo.user,
          conversation,
          messages: [],
          draft: '',
          onOpenGroupMember,
        }),
      );
      const title = fixture.host.querySelector<HTMLButtonElement>(
        '.weq-conversation-title-profile',
      )!;
      expect(title.tagName).toBe('BUTTON');
      expect(title.type).toBe('button');
      expect(title.title).toBe('查看好友名片');
      vi.spyOn(title, 'getBoundingClientRect').mockReturnValue({
        left: 180,
        bottom: 72,
      } as DOMRect);
      act(() => title.click());
      expect(onOpenGroupMember).toHaveBeenCalledWith(
        conversation.type === 'direct' ? conversation.otherUser : undefined,
        { x: 180, y: 72 },
      );
    } finally {
      fixture.close();
    }
  });

  it('群聊标题打开现有群名片，支持关闭且切换会话后不残留', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const render = (selected = conversation) =>
      fixture.render(
        h(ChatPane, { user: demo.user, conversation: selected, messages: [], draft: '' }),
      );
    try {
      render();
      const title = fixture.host.querySelector<HTMLButtonElement>(
        '.weq-conversation-title-profile',
      )!;
      expect(title.title).toBe('查看群名片');
      act(() => title.click());
      const card = document.querySelector('[role="dialog"][aria-label="群资料"]')!;
      expect(card.querySelector('.weq-profile-name')?.textContent).toBe(
        conversation.type === 'group' ? conversation.group.name : undefined,
      );
      act(() => card.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
      expect(document.querySelector('.weq-profile-dialog')).toBeNull();
      act(() => title.click());
      render(demo.conversations.find((item) => item.type === 'direct')!);
      expect(document.querySelector('.weq-profile-dialog')).toBeNull();
      render();
      expect(document.querySelector('.weq-profile-dialog')).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('会话资源占用右侧时临时收起旧群资料栏，关闭后恢复且不重建聊天', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    localStorage.setItem('chat-template.layout.groupInfoCollapsed', '0');
    function View() {
      const [open, setOpen] = useState(true);
      return h(
        WorkspacePages,
        { navigationKey: 'conversation' },
        h(
          WorkspaceContent,
          null,
          h(ChatPane, {
            user: demo.user,
            conversation: demo.conversations.find((item) => item.type === 'group'),
            messages: [],
            loading: false,
            draft: '保留正文',
            onSend: vi.fn(),
            onDraftChange: vi.fn(),
            onDraftClear: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
        open &&
          h(
            Modal,
            { presentation: 'sidecar', title: '群文件', onClose: () => setOpen(false) },
            h(
              'div',
              null,
              '合成资源',
              h('button', { 'aria-label': '关闭群文件', onClick: () => setOpen(false) }, '关闭'),
            ),
          ),
      );
    }
    try {
      fixture.render(h(View));
      const chat = fixture.host.querySelector('.chat-pane')!;
      expect(chat.classList.contains('group-info-collapsed')).toBe(true);
      expect(chat.querySelector('.group-info-panel')).toBeNull();
      expect(localStorage.getItem('chat-template.layout.groupInfoCollapsed')).toBe('0');
      act(() =>
        fixture.host.querySelector<HTMLButtonElement>('[aria-label="关闭群文件"]')!.click(),
      );
      expect(fixture.host.querySelector('.chat-pane')).toBe(chat);
      expect(chat.classList.contains('group-info-collapsed')).toBe(false);
      expect(chat.querySelector('.group-info-panel')).not.toBeNull();
    } finally {
      fixture.close();
    }
  });
  it('会话四按钮、默认真实和虚拟、范围切换、搜索、添加和多选复用普通行', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    const virtual = {
      id: 'virtual:persona:test',
      kind: 'persona' as const,
      ownerId: 'test',
      name: '合成克隆',
    };
    const open = vi.fn(),
      create = vi.fn();
    try {
      fixture.render(
        h(
          ContentSelectionProvider,
          null,
          h(
            ConversationDirectoryContext.Provider,
            { value: { virtual: [virtual], onVirtual: open, onCreate: create } },
            h(ConversationList, {
              conversations: demo.conversations.slice(0, 2),
              activeConversationId: null,
              preferences: {},
              drafts: {},
              onSelect: vi.fn(),
            }),
          ),
        ),
      );
      expect(fixture.host.querySelectorAll('.conversation-row')).toHaveLength(3);
      for (const name of ['搜索会话', '多选会话', '显示范围', '添加会话'])
        expect(button(fixture.host, name).textContent).toBe('');
      const clone = fixture.host.querySelector<HTMLButtonElement>(
        '[data-conversation-id="virtual:persona:test"]',
      )!;
      expect(clone.querySelector('[aria-label="虚拟会话"]')).not.toBeNull();
      act(() => clone.click());
      expect(open).toHaveBeenCalledWith(virtual);
      act(() => button(fixture.host, '添加会话').click());
      expect(create).not.toHaveBeenCalled();
      expect(button(fixture.host, '添加会话').getAttribute('aria-expanded')).toBe('true');
      const createItem = fixture.host.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
      expect(createItem.textContent).toContain('新建好友克隆');
      act(() => createItem.click());
      expect(create).toHaveBeenCalledOnce();
      expect(fixture.host.querySelector('[aria-label="添加会话菜单"]')).toBeNull();
      const add = button(fixture.host, '添加会话');
      act(() =>
        add.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
      );
      expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
      act(() =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      );
      expect(document.activeElement).toBe(add);
      expect(add.getAttribute('aria-expanded')).toBe('false');
      act(() => add.click());
      act(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      expect(add.getAttribute('aria-expanded')).toBe('false');
      expect(create).toHaveBeenCalledOnce();
      act(() => button(fixture.host, '显示范围').click());
      expect(fixture.host.querySelector('select')).toBeNull();
      const option = [
        ...fixture.host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ].find((item) => item.textContent === '仅克隆会话')!;
      act(() => option.click());
      expect(fixture.host.querySelectorAll('.conversation-row')).toHaveLength(1);
      act(() => button(fixture.host, '多选会话').click());
      act(() => fixture.host.querySelector<HTMLButtonElement>('.conversation-row')!.click());
      expect(
        fixture.host.querySelector('[aria-pressed="true"][data-conversation-id]'),
      ).not.toBeNull();
      expect(open).toHaveBeenCalledOnce();
      act(() => button(fixture.host, '退出多选').click());
      act(() => button(fixture.host, '搜索会话').click());
      const input = fixture.host.querySelector<HTMLInputElement>('input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '不存在',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(fixture.host.querySelectorAll('.conversation-row')).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });
  it('显示范围覆盖真实 / 克隆 / 频道私聊，频道私聊不再混在真实会话里', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    const virtual = {
      id: 'virtual:persona:test',
      kind: 'persona' as const,
      ownerId: 'test',
      name: '合成克隆',
    };
    const guild = {
      type: 'merged' as const,
      id: 'merged:guild-direct',
      mergedKind: 'guildDirect' as const,
      title: '频道私聊',
      avatarUrl: null,
      updatedAt: new Date().toISOString(),
      lastMessage: null,
      otherUser: null,
      group: null,
      members: [],
    };
    const pick = (label: string) => {
      act(() => button(fixture.host, '显示范围').click());
      const option = [
        ...fixture.host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ].find((item) => item.textContent === label)!;
      act(() => option.click());
    };
    try {
      fixture.render(
        h(
          ConversationDirectoryContext.Provider,
          { value: { virtual: [virtual], onVirtual: vi.fn(), onCreate: vi.fn() } },
          h(ConversationList, {
            conversations: [...demo.conversations.slice(0, 2), guild],
            activeConversationId: null,
            preferences: {},
            drafts: {},
            onSelect: vi.fn(),
          }),
        ),
      );
      // 全部：两条真实 + 克隆 + 频道私聊。
      expect(fixture.host.querySelectorAll('.conversation-row')).toHaveLength(4);
      pick('仅频道私聊');
      const rows = [...fixture.host.querySelectorAll<HTMLElement>('[data-conversation-id]')];
      expect(rows.map((row) => row.dataset.conversationId)).toEqual(['merged:guild-direct']);
      pick('仅克隆会话');
      expect(
        fixture.host.querySelector('[data-conversation-id="virtual:persona:test"]'),
      ).not.toBeNull();
      expect(fixture.host.querySelector('[data-conversation-id="merged:guild-direct"]')).toBeNull();
      pick('仅真实会话');
      expect(
        fixture.host.querySelectorAll('[data-conversation-id^="merged:guild-direct"]'),
      ).toHaveLength(0);
      expect(
        fixture.host.querySelector('[data-conversation-id="virtual:persona:test"]'),
      ).toBeNull();
    } finally {
      fixture.close();
    }
  });
  it('定位超出首批的会话会立即渲染对应行，不受显示范围限制', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    try {
      const conversations = Array.from({ length: 150 }, (_, index) => {
        const createdAt = new Date(Date.UTC(2026, 9, 21, 12) - index * 1000).toISOString();
        return {
          ...demo.conversations[0]!,
          id: `fixture-${index}`,
          updatedAt: createdAt,
          lastMessage: { id: `preview-${index}`, senderId: null, body: '定位夹具', createdAt },
        };
      });
      fixture.render(
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              virtual: [],
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
              locate: { id: 'fixture-140', revision: 1 },
            },
          },
          h(ConversationList, {
            conversations,
            activeConversationId: 'fixture-140',
            preferences: {},
            drafts: {},
            onSelect: vi.fn(),
          }),
        ),
      );
      expect(fixture.host.querySelector('[data-conversation-id="fixture-140"]')).not.toBeNull();
      expect(
        fixture.host.querySelector<HTMLElement>('.weq-conversation-window')!.scrollTop,
      ).toBeGreaterThan(8000);
      expect(fixture.host.querySelectorAll('.conversation-row').length).toBeLessThan(30);
    } finally {
      fixture.close();
    }
  });
  it('右键转发传真实消息，多选操作栏只有图标和提示', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    const forward = vi.fn();
    const composition = vi.fn();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const message = {
      ...demo.messages[0]!,
      id: 'fixture',
      conversationId: conversation.id,
      body: '合成正文',
      qqElements: [{ type: 'text', data: { textContent: '合成正文' } }],
    };
    try {
      fixture.render(
        h(ChatPane, {
          user: demo.user,
          conversation,
          messages: [message],
          draft: '',
          onSend: vi.fn(),
          onDraftChange: vi.fn(),
          onDraftClear: vi.fn(),
          onBack: vi.fn(),
          onForwardMessages: forward,
          onAddToComposition: composition,
          sendAvailable: true,
        }),
      );
      const openMenu = () =>
        act(() =>
          fixture.host
            .querySelector('.message-bubble')!
            .dispatchEvent(
              new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
            ),
        );
      openMenu();
      act(() => button(fixture.host, '添加到素材库').click());
      expect(composition).toHaveBeenCalledWith([message]);
      openMenu();
      act(() => button(fixture.host, '转发').click());
      expect(forward).toHaveBeenCalledWith([message], conversation);
      openMenu();
      act(() => button(fixture.host, '多选').click());
      const actions = [
        ...fixture.host.querySelectorAll<HTMLButtonElement>('.selection-bar-actions button'),
      ];
      expect(actions.length).toBe(5);
      for (const action of actions) {
        expect(action.textContent).toBe('');
        expect(action.getAttribute('title')).toBeTruthy();
        expect(action.getAttribute('aria-label')).toBeTruthy();
      }
      act(() => button(fixture.host, '转发').click());
      act(() => button(document.body, '逐条转发').click());
      expect(forward).toHaveBeenCalledTimes(2);
      act(() => button(fixture.host, '添加到素材库').click());
      expect(composition).toHaveBeenCalledTimes(2);
    } finally {
      fixture.close();
    }
  });
  it('空间卡片点击和键盘进入内部精确页面', () => {
    const fixture = mount();
    const navigate = vi.fn();
    try {
      fixture.render(
        h(
          QzoneCardNavigationContext.Provider,
          { value: navigate },
          h(QqArk, {
            arkData: {
              app: 'synthetic.share',
              meta: {
                detail: { title: '说说', jumpUrl: 'https://user.qzone.qq.com/123456/mood/fixture' },
              },
            },
          }),
        ),
      );
      const card = fixture.host.querySelector<HTMLElement>('[role="link"]')!;
      act(() => card.click());
      act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      expect(navigate).toHaveBeenCalledTimes(2);
      expect(navigate).toHaveBeenCalledWith({ kind: 'post', uin: '123456', tid: 'fixture' });
    } finally {
      fixture.close();
    }
  });
  it('私聊预览留在名片内，没有新浮窗或输入框，返回不关闭名片', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    const close = vi.fn();
    const preview = vi.fn();
    const conversation = demo.conversations.find((item) => item.type === 'direct')!;
    function Card() {
      const [open, setOpen] = useState(false);
      return h(MemberProfileCard, {
        member: { ...conversation.otherUser!, identityLabel: 'QQ', identityValue: '123456' },
        anchor: { x: 100, y: 100 },
        onClose: close,
        onPreviewChat: () => {
          preview();
          setOpen(true);
        },
        previewContent: open
          ? h(GapMessagesModal, {
              embedded: true,
              preview: true,
              conversation,
              user: demo.user,
              messages: [],
              loading: false,
              loadingMore: false,
              error: null,
              hasMore: false,
              moreFailed: false,
              totalCount: 0,
              onLoadMore: vi.fn(),
              onClose: () => setOpen(false),
            })
          : null,
      });
    }
    try {
      fixture.render(h(Card));
      const modal = document.querySelector('.weq-member-pop')!;
      act(() => button(modal, '预览私聊').click());
      expect(preview).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(document.querySelector('.weq-window-layer')).toBeNull();
      expect(modal.textContent).toContain('预览私聊');
      expect(modal.textContent).toContain('没有本地聊天记录');
      expect(modal.querySelector('textarea, [contenteditable="true"]')).toBeNull();
      act(() => button(modal, '返回资料').click());
      expect(close).not.toHaveBeenCalled();
      expect(modal.textContent).not.toContain('没有本地聊天记录');
      act(() => button(modal, '关闭').click());
      expect(close).toHaveBeenCalledOnce();
    } finally {
      fixture.close();
    }
  });
  it('联系人搜索、多选、刷新在通知上方同一工具行，点击用高亮选择不打开名片', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    const refresh = vi.fn(),
      select = vi.fn();
    const contacts = [
      { ...demo.user, id: 'u_contact', displayName: '合成好友', createdAt: '2026-10-17' },
    ];
    function Contacts() {
      const [query, onQuery] = useState('');
      return h(
        ContentSelectionProvider,
        null,
        h(
          ContactDirectoryContext.Provider,
          { value: { query, onQuery, ids: ['u_contact'] } },
          h(SidebarHeader, {
            user: demo.user,
            view: 'contacts',
            contactTab: 'friends',
            query: '',
            onQueryChange: vi.fn(),
            onQuickInvite: vi.fn(),
            onCreateGroup: vi.fn(),
            onOpenProfile: vi.fn(),
            onOpenFriendNotices: vi.fn(),
            onOpenGroupNotices: vi.fn(),
            onContactTabChange: vi.fn(),
            onRefreshContacts: refresh,
            activeNotice: null,
            showSearch: false,
          }),
          h(ContactList, { contacts, activeContactId: null, onSelect: select }),
        ),
      );
    }
    try {
      fixture.render(h(Contacts));
      const tools = fixture.host.querySelector('.contact-tools')!;
      expect(tools.firstElementChild?.classList.contains('weq-directory-toolbar')).toBe(true);
      act(() => button(fixture.host, '刷新联系人列表').click());
      expect(refresh).toHaveBeenCalledOnce();
      act(() => button(fixture.host, '多选联系人').click());
      act(() => fixture.host.querySelector<HTMLButtonElement>('.contact-row')!.click());
      expect(fixture.host.querySelector('.contact-row.is-multiselected')).not.toBeNull();
      expect(fixture.host.querySelector('input[type="checkbox"]')).toBeNull();
      expect(fixture.host.querySelector('[aria-label="复制所选会话"]')).toBeNull();
      expect(select).not.toHaveBeenCalled();
      act(() => button(fixture.host, '退出多选').click());
      act(() => button(fixture.host, '搜索联系人').click());
      expect(fixture.host.querySelector('input')?.closest('.weq-directory-toolbar')).toBe(
        fixture.host.querySelector('.weq-directory-toolbar'),
      );
      expect(fixture.host.querySelector('[aria-label="多选联系人"]')).toBeNull();
    } finally {
      fixture.close();
    }
  });
  it('QQ 动态说说卡片识别真实 schema 并内部定位，不只支持 Ark 链接', () => {
    const fixture = mount();
    const navigate = vi.fn();
    try {
      fixture.render(
        h(
          QzoneCardNavigationContext.Provider,
          { value: navigate },
          h(QqDynamic, {
            dynamicType: 2,
            meta: JSON.stringify({
              jump_schema: `mqqapi://qzoneschema/?schema=${encodeURIComponent(btoa('mqzone://arouse/detail?appid=311&uin=123456&cellid=fixture'))}`,
            }),
          }),
        ),
      );
      act(() => fixture.host.querySelector<HTMLElement>('[role="link"]')!.click());
      expect(navigate).toHaveBeenCalledWith({ kind: 'post', uin: '123456', tid: 'fixture' });
    } finally {
      fixture.close();
    }
  });
});
