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
import { Modal } from '../src/renderer/src/components/Dialog';
import { WorkspaceContent, WorkspacePages } from '../src/renderer/src/components/WorkspacePages';

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
            h('div', null, '合成资源'),
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
      for (const name of ['搜索会话', '多选会话', '显示范围', '添加会话克隆'])
        expect(button(fixture.host, name).textContent).toBe('');
      const clone = fixture.host.querySelector<HTMLButtonElement>(
        '[data-conversation-id="virtual:persona:test"]',
      )!;
      expect(clone.querySelector('[aria-label="虚拟会话"]')).not.toBeNull();
      act(() => clone.click());
      expect(open).toHaveBeenCalledWith(virtual);
      act(() => button(fixture.host, '添加会话克隆').click());
      expect(create).toHaveBeenCalledOnce();
      act(() => button(fixture.host, '显示范围').click());
      expect(fixture.host.querySelector('select')).toBeNull();
      const option = [
        ...fixture.host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ].find((item) => item.textContent === '仅虚拟会话')!;
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
  it('定位超出首批的会话会立即渲染对应行，不受显示范围限制', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    try {
      const conversations = Array.from({ length: 150 }, (_, index) => ({
        ...demo.conversations[0]!,
        id: `fixture-${index}`,
      }));
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
      act(() => button(fixture.host, '转发').click());
      expect(forward).toHaveBeenCalledWith([message], conversation);
      openMenu();
      act(() => button(fixture.host, '多选').click());
      const actions = [
        ...fixture.host.querySelectorAll<HTMLButtonElement>('.selection-bar-actions button'),
      ];
      expect(actions.length).toBe(7);
      for (const action of actions) {
        expect(action.textContent).toBe('');
        expect(action.getAttribute('title')).toBeTruthy();
        expect(action.getAttribute('aria-label')).toBeTruthy();
      }
      act(() => button(fixture.host, '逐条转发').click());
      expect(forward).toHaveBeenCalledTimes(2);
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
  it('私聊预览没有输入框或修改入口，关闭不跳转', () => {
    const fixture = mount();
    const demo = createTemplateDemoData();
    const close = vi.fn();
    try {
      fixture.render(
        h(GapMessagesModal, {
          preview: true,
          conversation: demo.conversations.find((item) => item.type === 'direct')!,
          user: demo.user,
          messages: [],
          loading: false,
          loadingMore: false,
          error: null,
          hasMore: false,
          moreFailed: false,
          totalCount: 0,
          onLoadMore: vi.fn(),
          onClose: close,
        }),
      );
      const modal = document.querySelector('[role="dialog"]')!;
      expect(modal.textContent).toContain('预览私聊');
      expect(modal.querySelector('textarea, [contenteditable="true"]')).toBeNull();
      act(() => modal.querySelector<HTMLButtonElement>('button[title="关闭"]')!.click());
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
