import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  ContactList,
  GroupList,
  ConversationList,
} from '../src/renderer/src/im-template/template/conversationLists';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ContactDirectoryContext,
  ConversationDirectoryContext,
} from '../src/renderer/src/lib/conversationDirectory';
import {
  ContentSelectionProvider,
  useCurrentContentSelection,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));
vi.mock('../src/renderer/src/hooks/useFriendSpecialCare', () => ({
  useFriendSpecialCare: () => ({ enabled: false, disabled: false, change: vi.fn() }),
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])('好友 Shift 连选不跳过重复分组中的密友，反向=%s', (reverse) => {
  const base = createTemplateDemoData().contacts[0]!;
  const contacts = ['a', 'b', 'c', 'd'].map((id) => ({
    ...base,
    id,
    displayName: `合成好友 ${id}`,
    extRelation: id === 'b' ? { displayId: 26 } : undefined,
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onSelect = vi.fn();
  function Probe() {
    return h('output', null, JSON.stringify(useCurrentContentSelection()));
  }
  const selected = () =>
    JSON.parse(host.querySelector('output')!.textContent!).scope.ids as string[];
  const row = (category: number, index: number) =>
    host.querySelectorAll('.contact-cat')[category]!.querySelectorAll('button.contact-row')[index]!;
  const click = (element: Element, modifiers: MouseEventInit = {}) =>
    act(() =>
      element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }),
      ),
    );
  try {
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(ContactList, {
            contacts,
            specialSections: [
              { id: 'special:care', name: '特别关心', items: [contacts[2]!] },
              { id: 'special:intimate', name: '亲密关系', items: [contacts[1]!] },
            ],
            activeContactId: null,
            onSelect,
          }),
          h(Probe),
        ),
      ),
    );
    // 特殊分组先保持折叠，在普通分组内选择完整范围。
    click(host.querySelectorAll('.contact-cat-header')[2]!);
    click(row(2, reverse ? 3 : 0), { ctrlKey: true });
    click(row(2, reverse ? 0 : 3), { shiftKey: true });
    expect(selected()).toEqual(['a', 'b', 'c', 'd']);
    expect(host.querySelectorAll('.is-multiselected')).toHaveLength(4);
    // 展开重复项后，从普通分组中的密友作为端点连选，不能跳到顶部的副本。
    click(host.querySelectorAll('.contact-cat-header')[0]!);
    click(host.querySelectorAll('.contact-cat-header')[1]!);
    click(row(2, 1), { shiftKey: true });
    expect(selected()).toEqual(reverse ? ['b', 'c', 'd'] : ['a', 'b']);
    // 任一副本都能取消该好友，再用修饰键追加一个跨分组范围。
    click(row(1, 0), { ctrlKey: true });
    expect(selected()).not.toContain('b');
    click(row(2, 1), { ctrlKey: true, shiftKey: true });
    expect(new Set(selected())).toEqual(new Set(reverse ? ['a', 'b', 'c', 'd'] : ['a', 'b']));
    expect(selected().filter((id) => id === 'b')).toHaveLength(1);
    click(row(2, 0));
    act(() =>
      row(2, 0).dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', shiftKey: true }),
      ),
    );
    expect(selected()).toEqual(['a', 'b']);
    act(() =>
      row(2, 1).dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', shiftKey: true }),
      ),
    );
    expect(selected()).toEqual(['a', 'b', 'c']);
    expect(row(1, 0).getAttribute('aria-pressed')).toBe('true');
    expect(row(2, 1).getAttribute('aria-pressed')).toBe('true');
    act(() =>
      row(2, 1).dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'a', metaKey: true }),
      ),
    );
    expect(selected()).toEqual(['a', 'b', 'c', 'd']);
    expect(onSelect).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each(['会话', '联系人'])('%s 搜索复用原添加按钮和图标，关闭或 Escape 后恢复', (noun) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const noop = vi.fn();
  try {
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          noun === '会话'
            ? h(ConversationList, {
                conversations: [],
                preferences: {},
                drafts: {},
                activeConversationId: null,
                onSelect: noop,
              })
            : h(SidebarHeader, {
                user: createTemplateDemoData().user,
                view: 'contacts',
                query: '',
                showSearch: false,
                onQueryChange: noop,
                onOpenProfile: noop,
                onOpenFriendNotices: noop,
                onOpenGroupNotices: noop,
                contactTab: 'friends',
                onContactTabChange: noop,
                activeNotice: null,
              }),
        ),
      ),
    );
    const toolbar = host.querySelector('.weq-directory-toolbar')!;
    const label = noun === '会话' ? '添加会话' : '添加联系人或分组';
    const add = toolbar.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    const icon = add.querySelector('svg');
    for (const useEscape of [false, true]) {
      act(() => toolbar.querySelector<HTMLButtonElement>(`[aria-label="搜索${noun}"]`)!.click());
      const input = toolbar.querySelector('input')!;
      expect(document.activeElement).toBe(input);
      expect(toolbar.classList.contains('is-searching')).toBe(true);
      expect(toolbar.querySelector(`[aria-label="退出搜索${noun}"]`)).toBe(add);
      expect(add.disabled).toBe(false);
      expect(add.querySelector('svg')).toBe(icon);
      expect(icon?.classList.contains('weq-directory-add-icon')).toBe(true);
      expect(toolbar.querySelectorAll('button')).toHaveLength(1);
      expect(toolbar.querySelector('.lucide-x')).toBeNull();
      act(() => {
        if (useEscape)
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else add.click();
      });
      expect(toolbar.classList.contains('is-searching')).toBe(false);
      expect(toolbar.querySelector(`[aria-label="${label}"]`)).toBe(add);
      expect(add.querySelector('svg')).toBe(icon);
      expect(toolbar.querySelector('input')).toBeNull();
      expect(toolbar.querySelector('[role="menu"]')).toBeNull();
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each(['friends', 'groups'] as const)(
  '%s 未读角标遵循消息列表的免打扰规则，含本地覆盖与取消覆盖',
  (tab) => {
    const demo = createTemplateDemoData();
    const base = demo.conversations.find(
      (row) => row.type === (tab === 'friends' ? 'direct' : 'group'),
    )!;
    const row =
      tab === 'friends'
        ? {
            ...base,
            id: 'u_fixture',
            unreadCount: 3,
            otherUser: { ...base.otherUser!, id: 'u_fixture' },
          }
        : {
            ...base,
            id: '10001',
            unreadCount: 3,
            group: { ...base.group!, id: '10001', listed: true },
          };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      for (const [databaseMuted, localMuted, expected] of [
        [false, undefined, false],
        [true, undefined, true],
        [false, true, true],
        [true, false, false],
      ] as const) {
        const conversation = {
          ...row,
          preference: { pinned: false, blocked: false, muted: databaseMuted },
        };
        const preferences =
          localMuted === undefined
            ? {}
            : { [row.id]: { pinned: false, blocked: false, muted: localMuted } };
        act(() =>
          root.render(
            h(
              ContentSelectionProvider,
              null,
              h(
                ConversationDirectoryContext.Provider,
                {
                  value: {
                    real: [conversation],
                    virtual: [],
                    preferences,
                    showContactUnreadCount: true,
                    onVirtual: vi.fn(),
                    onCreate: vi.fn(),
                  },
                },
                h(
                  'section',
                  { 'data-source': 'messages' },
                  h(ConversationList, {
                    conversations: [conversation],
                    preferences,
                    drafts: {},
                    activeConversationId: null,
                    onSelect: vi.fn(),
                  }),
                ),
                h(
                  'section',
                  { 'data-source': 'contacts' },
                  tab === 'friends'
                    ? h(ContactList, {
                        contacts: [conversation.otherUser!],
                        activeContactId: null,
                        onSelect: vi.fn(),
                      })
                    : h(GroupList, {
                        conversations: [conversation],
                        activeConversationId: null,
                        onSelect: vi.fn(),
                      }),
                ),
              ),
            ),
          ),
        );
        const category = host.querySelector<HTMLButtonElement>('.contact-cat-header')!;
        if (category.getAttribute('aria-expanded') === 'false') act(() => category.click());
        const messageBadge = host.querySelector('[data-source="messages"] .row-unread')!;
        const contactBadge = host.querySelector('[data-source="contacts"] .row-unread')!;
        expect(contactBadge.textContent).toBe(messageBadge.textContent);
        expect(contactBadge.classList.contains('muted')).toBe(expected);
        expect(contactBadge.className).toBe(messageBadge.className);
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('会话混选多个群、好友和虚拟会话时，名单仅带入所选真实群且使用群号', () => {
  const demo = createTemplateDemoData();
  const base = demo.conversations.find((row) => row.type === 'group')!;
  const friend = demo.conversations.find((row) => row.type === 'direct')!;
  const groups = ['10001', '10002'].map((id) => ({
    ...base,
    id: `row:${id}`,
    group: { ...base.group!, id },
  }));
  const rows = [...groups, friend];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    return h('output', null, JSON.stringify(useContentExportRequest()?.selection));
  }
  try {
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(
            ConversationDirectoryContext.Provider,
            {
              value: {
                real: rows,
                virtual: [
                  { id: 'virtual:fixture', kind: 'group', ownerId: 'fixture', name: '合成虚拟群' },
                ],
                onVirtual: vi.fn(),
                onCreate: vi.fn(),
              },
            },
            h(ConversationList, {
              conversations: rows,
              activeConversationId: null,
              preferences: {},
              drafts: {},
              onSelect: vi.fn(),
            }),
            h(Probe),
          ),
        ),
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="多选会话"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="全选当前结果"]')!.click());
    expect(host.querySelectorAll('.is-multiselected')).toHaveLength(4);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="导出名单"]')!.click());
    expect(JSON.parse(host.querySelector('output')!.textContent!)).toEqual({
      owner: { kind: 'contacts', container: 'groups' },
      scope: { type: 'items', ids: ['10001', '10002'] },
    });
    expect(host.querySelectorAll('.is-multiselected')).toHaveLength(4);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each(['friends', 'groups'] as const)(
  '%s 顶部选择控制、底部操作、右键读状态和未读数显示互相独立',
  (tab) => {
    const demo = createTemplateDemoData();
    const base = demo.conversations.find(
      (row) => row.type === (tab === 'friends' ? 'direct' : 'group'),
    )!;
    const rows = [0, 1].map((index) =>
      tab === 'groups'
        ? {
            ...base,
            id: String(10001 + index),
            unreadCount: index ? 0 : 123,
            group: {
              ...base.group!,
              id: String(10001 + index),
              name: `合成群 ${index}`,
              listed: true,
            },
          }
        : {
            ...base,
            id: `u_fixture${index}`,
            unreadCount: index ? 0 : 123,
            otherUser: {
              ...base.otherUser!,
              id: `u_fixture${index}`,
              displayName: `合成好友 ${index}`,
            },
          },
    );
    const mark = vi.fn();
    const roam = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const button = (label: string) =>
      host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    const menu = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (node) => node.textContent === label,
      );
    function Probe() {
      return h('output', null, JSON.stringify(useContentExportRequest()?.selection));
    }
    function Fixture({ showUnread }: { showUnread: boolean }) {
      return h(
        ContentSelectionProvider,
        null,
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              real: rows,
              virtual: [],
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
              onReadState: mark,
              onRoaming: roam,
              showContactUnreadCount: showUnread,
            },
          },
          h(
            ContactDirectoryContext.Provider,
            { value: { query: '', onQuery: vi.fn(), ids: rows.map((row) => row.id) } },
            h(SidebarHeader, {
              user: demo.user,
              view: 'contacts',
              contactTab: tab,
              query: '',
              onQueryChange: vi.fn(),
              onOpenProfile: vi.fn(),
              onOpenFriendNotices: vi.fn(),
              onOpenGroupNotices: vi.fn(),
              onContactTabChange: vi.fn(),
              activeNotice: null,
            }),
            tab === 'friends'
              ? h(ContactList, {
                  contacts: rows.map((row) => row.otherUser!),
                  activeContactId: null,
                  onSelect: vi.fn(),
                })
              : h(GroupList, {
                  conversations: rows,
                  activeConversationId: null,
                  onSelect: vi.fn(),
                }),
            h(Probe),
          ),
        ),
      );
    }
    try {
      act(() => root.render(h(Fixture, { showUnread: false })));
      act(() => host.querySelector<HTMLButtonElement>('.contact-cat-header')!.click());
      expect(host.querySelector('.row-unread')).toBeNull();
      act(() => root.render(h(Fixture, { showUnread: true })));
      expect(host.querySelector('.row-unread')?.textContent).toBe('99+');
      act(() => button('多选联系人').click());
      expect(host.querySelector('.weq-directory-selection-count')?.textContent).toBe('已选 0');
      const bottom = host.querySelector('[aria-label="会话多选操作"]')!;
      expect(bottom.querySelectorAll('button')).toHaveLength(4);
      expect(bottom.querySelector<HTMLButtonElement>('[aria-label="导出名单"]')!.disabled).toBe(
        true,
      );
      act(() => button('反选当前结果').click());
      expect(host.querySelectorAll('.is-multiselected')).toHaveLength(2);
      expect(host.querySelector('.weq-directory-selection-count')?.textContent).toBe('已选 2');
      act(() => button('标为已读').click());
      expect(mark).toHaveBeenLastCalledWith(rows, false);
      act(() => button('拉取所选会话漫游消息').click());
      expect(roam.mock.calls[0]![0]).toHaveLength(2);
      const roster = bottom.querySelector<HTMLButtonElement>('[aria-label="导出名单"]')!;
      expect(roster.disabled).toBe(tab === 'friends');
      if (tab === 'groups') {
        act(() => roster.click());
        expect(JSON.parse(host.querySelector('output')!.textContent!)).toEqual({
          owner: { kind: 'contacts', container: 'groups' },
          scope: { type: 'items', ids: rows.map((row) => row.id) },
        });
      }
      act(() =>
        host
          .querySelector<HTMLElement>('[data-weq-select-id]')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      );
      expect(menu('多选')).toBeUndefined();
      expect(menu('标为已读')).toBeDefined();
      act(() => menu('标为未读')!.click());
      expect(mark).toHaveBeenLastCalledWith(rows, true);
      act(() => button('取消全选当前结果').click());
      expect(host.querySelectorAll('.is-multiselected')).toHaveLength(0);
      act(() => button('全选当前结果').click());
      expect(host.querySelectorAll('.is-multiselected')).toHaveLength(2);
      act(() => button('反选当前结果').click());
      expect(host.querySelectorAll('.is-multiselected')).toHaveLength(0);
      act(() => button('退出多选').click());
      expect(host.querySelector('[aria-label="会话多选操作"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
