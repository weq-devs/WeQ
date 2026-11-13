import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MergedSessionPanel } from '../src/renderer/src/components/sidebar/MergedSessionPanel';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import {
  ContentSelectionProvider,
  useCurrentContentSelection,
} from '../src/renderer/src/state/contentSelection';
import { createTemplateDemoData } from './support/templateDemoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import {
  loadGroupAssistantPins,
  saveGroupAssistantPins,
  sidebarConversationsWithoutAssistant,
} from '../src/renderer/src/lib/groupAssistant';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
import { useViewState } from '../src/renderer/src/state/view';
import { conversationViewFixture } from './support/conversation-view-fixture';
import type { ConversationView } from '../src/renderer/src/lib/conversationViews';
import { formatConversationTime } from '../src/renderer/src/lib/conversationTime';

vi.mock('../src/renderer/src/trpc/client', () => {
  const query = { useQuery: () => ({ data: undefined }) };
  return {
    trpc: {
      account: {
        listOfficialAccounts: query,
        listServiceAccounts: query,
        listHiddenSessions: query,
        listDeletedSessions: query,
        guildDirectListSessions: query,
      },
    },
  };
});
afterEach(() => vi.unstubAllGlobals());

it('群助手共用悬停保持、菜单目标与身份高亮，设置关闭和失焦立即恢复排序', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let revision = 0;
  const settings = (enabled: boolean) =>
    act(() =>
      acceptPreferences(
        {
          epoch: 'group-assistant-hover',
          revision: ++revision,
          values: { keepConversationPositionOnHover: enabled },
          records: {},
        },
        false,
      ),
    );
  const rows = groups().map((row) => ({
    ...row,
    lastMessage: null,
    preference: { ...row.preference, pinned: false },
  }));
  const render = (values: Conversation[]) =>
    act(() =>
      root.render(
        h(MergedSessionPanel, {
          kind: 'groupAssistant',
          conversations: values,
          groupAssistantIds: new Set(values.map((row) => row.id)),
          anchorX: 10,
          anchorY: 10,
          onBack: vi.fn(),
          onSelectConversation: vi.fn(),
        }),
      ),
    );
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('.conversation-row')];
  const ids = () => buttons().map((row) => row.dataset.conversationId);
  const pointer = (
    target: Element,
    type: string,
    relatedTarget?: EventTarget,
    pointerType = 'mouse',
  ) =>
    act(() =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget })),
    );
  const closeMenu = () =>
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
  const previous = useViewState.getState().openedUin;
  try {
    settings(true);
    render(rows);
    pointer(buttons()[0]!, 'pointerover');
    const updated = [rows[0], { ...rows[1], updatedAt: '2030-01-03T00:00:00Z', unreadCount: 9 }];
    render(updated);
    expect(ids()).toEqual(['10001', '10002']);
    expect(buttons()[1]!.textContent).toContain('9');
    act(() => buttons()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.querySelector('.weq-conversation-actions-target')?.textContent).toContain(
      '合成助手群一',
    );
    expect(buttons()[0]!.classList.contains('is-context-target')).toBe(true);
    pointer(buttons()[0]!, 'pointerout', menu);
    expect(ids()).toEqual(['10001', '10002']);
    closeMenu();
    expect(ids()).toEqual(['10002', '10001']);
    expect(host.querySelector('.is-context-target')).toBeNull();
    pointer(buttons()[0]!, 'pointerover');
    render(rows);
    expect(ids()).toEqual(['10002', '10001']);
    settings(false);
    expect(ids()).toEqual(['10001', '10002']);
    settings(true);
    render(updated);
    expect(ids()).toEqual(['10001', '10002']);
    act(() => window.dispatchEvent(new Event('blur')));
    expect(ids()).toEqual(['10002', '10001']);
    pointer(buttons()[0]!, 'pointerover', undefined, 'touch');
    render(rows);
    expect(ids()).toEqual(['10001', '10002']);
    act(() =>
      buttons()[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
      ),
    );
    act(() => useViewState.getState().setOpenedUin('assistant-other'));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => buttons()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    render([rows[1]]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    useViewState.getState().setOpenedUin(previous);
  }
});

function groups(): Conversation[] {
  const group = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  return [
    {
      ...group,
      id: '10001',
      group: { ...group.group!, id: '10001', name: '合成助手群一' },
      updatedAt: '2026-10-18T02:00:00Z',
      preference: { pinned: false, muted: true, blocked: false },
    },
    {
      ...group,
      id: '10002',
      group: { ...group.group!, id: '10002', name: '合成助手群二' },
      updatedAt: '2026-10-17T02:00:00Z',
      preference: { pinned: true, muted: true, blocked: false },
    },
  ];
}

describe('群助手', () => {
  it('搜索与多选共用工具栏，支持群名、群号筛选和退出搜索', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const rows = groups();
    try {
      act(() =>
        root.render(
          h(
            ContentSelectionProvider,
            null,
            h(MergedSessionPanel, {
              kind: 'groupAssistant',
              conversations: rows,
              groupAssistantIds: new Set(rows.map((row) => row.id)),
              anchorX: 0,
              anchorY: 0,
              onBack: vi.fn(),
              onSelectConversation: vi.fn(),
            }),
          ),
        ),
      );
      const toolbar = host.querySelector('.weq-directory-toolbar')!;
      expect(host.querySelector('input')).toBeNull();
      expect(toolbar.querySelector('[aria-label="多选群助手会话"]')).not.toBeNull();
      act(() => toolbar.querySelector<HTMLButtonElement>('[aria-label="搜索群助手会话"]')!.click());
      const input = toolbar.querySelector('input')!;
      expect(document.activeElement).toBe(input);
      const search = (value: string) => {
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            value,
          );
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      };
      search('群一');
      expect(host.querySelectorAll('.weq-merged-popover-row')).toHaveLength(1);
      expect(host.querySelector('.weq-merged-popover-body')?.textContent).toContain('合成助手群一');
      search('10002');
      expect(host.querySelectorAll('.weq-merged-popover-row')).toHaveLength(1);
      expect(host.querySelector('.weq-merged-popover-body')?.textContent).toContain('合成助手群二');
      act(() =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(toolbar.querySelector('input')).toBeNull();
      expect(host.querySelectorAll('.weq-merged-popover-row')).toHaveLength(2);
      expect(host.querySelectorAll('.weq-conversation-list .conversation-row')).toHaveLength(2);
      expect(host.querySelector('.weq-conversation-list .row-main strong')).not.toBeNull();
      expect(host.querySelector('.weq-conversation-list .row-preview-line')).not.toBeNull();
      act(() => toolbar.querySelector<HTMLButtonElement>('[aria-label="多选群助手会话"]')!.click());
      expect(toolbar.querySelector('[aria-label="全选当前结果"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('会话时间与外层列表一致：今天、昨天、周内、更早和跨年', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00+08:00'));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const dates = [
      new Date('2026-10-26T09:05:00+08:00'),
      new Date('2026-10-25T23:59:00+08:00'),
      new Date('2026-10-20T09:00:00+08:00'),
      new Date('2026-10-19T09:00:00+08:00'),
      new Date('2025-12-31T09:00:00+08:00'),
    ];
    const rows = dates.map((date, index) => ({
      ...groups()[0],
      id: `time-${index}`,
      updatedAt: date.toISOString(),
    }));
    try {
      act(() =>
        root.render(
          h(
            ContentSelectionProvider,
            null,
            h(ConversationList, {
              conversations: rows,
              activeConversationId: null,
              preferences: {},
              drafts: {},
              onSelect: vi.fn(),
            }),
            h(MergedSessionPanel, {
              kind: 'groupAssistant',
              conversations: rows,
              groupAssistantIds: new Set(rows.map((row) => row.id)),
              anchorX: 0,
              anchorY: 0,
              onBack: vi.fn(),
              onSelectConversation: vi.fn(),
            }),
          ),
        ),
      );
      const times = (selector: string) =>
        Array.from(host.querySelectorAll(selector), (node) => node.textContent);
      const expected = dates.map((date) => formatConversationTime(date.toISOString()));
      expect(times('.weq-conversation-window .row-time-line')).toEqual(expected);
      expect(times('.weq-conversation-list .row-time-line')).toEqual(expected);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  });

  it('常规全选只选择平铺会话，进入群助手后才选择内部群，聚合入口始终只是导航', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const assistantGroups = groups();
    const other: Conversation = { ...assistantGroups[0], id: '10003' };
    const entry: Conversation = {
      ...assistantGroups[0],
      type: 'merged',
      id: 'merged:group-assistant',
      mergedKind: 'groupAssistant',
      title: '群助手',
      avatarUrl: null,
      group: null,
      otherUser: null,
      members: [],
    };
    const assistantIds = new Set(assistantGroups.map((row) => row.id));
    const select = vi.fn(),
      pin = vi.fn();
    function Probe() {
      return h('output', null, JSON.stringify(useCurrentContentSelection()));
    }
    function View() {
      const [view, setView] = useState<ConversationView>('regular');
      const [returnToRegular, setReturnToRegular] = useState(false);
      const fixture = conversationViewFixture(
        { regular: [other, entry], groupAssistant: assistantGroups },
        view,
      );
      return h(
        ContentSelectionProvider,
        null,
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              ...fixture,
              real: [...assistantGroups, other, entry],
              virtual: [],
              groupAssistantIds: assistantIds,
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
              onPin: pin,
              returnToRegular,
              onViewChange: (next, fromAggregate) => {
                setView(next);
                setReturnToRegular(Boolean(fromAggregate));
              },
              onReturnToRegular: () => {
                setView('regular');
                setReturnToRegular(false);
              },
            },
          },
          h(ConversationList, {
            conversations: fixture.rows,
            activeConversationId: null,
            preferences: {},
            drafts: {},
            onSelect: select,
          }),
          h(Probe),
        ),
      );
    }
    try {
      act(() => root.render(h(View)));
      const main = host.querySelector('.weq-conversation-directory')!;
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="多选会话"]')!.click());
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="全选当前结果"]')!.click());
      const selection = () =>
        (JSON.parse(host.querySelector('output')!.textContent!)?.scope?.ids ?? []) as string[];
      expect(selection()).toEqual(['10003']);
      expect(main.textContent).toContain('已选 1');
      expect(host.querySelectorAll('.is-multiselected')).toHaveLength(1);
      expect(host.querySelector('[data-conversation-id="10001"]')).toBeNull();
      expect(
        host
          .querySelector('[data-conversation-id="merged:group-assistant"]')
          ?.getAttribute('aria-pressed'),
      ).not.toBe('true');
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
      act(() =>
        host
          .querySelector<HTMLButtonElement>('[data-conversation-id="merged:group-assistant"]')!
          .click(),
      );
      expect(main.querySelector('[aria-label="返回常规视图"]')).not.toBeNull();
      expect(host.querySelector('[data-conversation-id="10003"]')).toBeNull();
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="多选会话"]')!.click());
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="全选当前结果"]')!.click());
      expect(selection().sort()).toEqual(['10001', '10002']);
      expect(host.querySelectorAll('.is-multiselected')).toHaveLength(2);
      act(() =>
        host
          .querySelector('[data-conversation-id="10001"]')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
      );
      expect(document.querySelector('.weq-conversation-actions-target')?.textContent).toContain(
        '已选 2 个会话',
      );
      expect(host.querySelectorAll('.is-context-target')).toHaveLength(2);
      act(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      act(() => host.querySelector<HTMLButtonElement>('[data-conversation-id="10001"]')!.click());
      expect(selection()).toEqual(['10002']);
      expect(select).not.toHaveBeenCalled();
      act(() =>
        host.querySelector('[data-conversation-id="10002"]')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(selection().sort()).toEqual(['10001', '10002']);
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="返回常规视图"]')!.click());
      expect(selection()).toEqual([]);
      expect(main.querySelector('[aria-label="会话视图"]')).not.toBeNull();
      const ordinary = main.querySelector<HTMLElement>('[data-conversation-id="10003"]')!;
      act(() =>
        ordinary.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      );
      act(() =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((node) => node.textContent === '置顶')!
          .click(),
      );
      expect(pin).toHaveBeenCalledWith(other, true);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each(
    [0, 1, 2].flatMap((groupCount) =>
      [false, true].flatMap((selecting) =>
        ['mouse', 'ContextMenu', 'F10'].map((trigger) => ({ groupCount, selecting, trigger })),
      ),
    ),
  )(
    '群助手入口菜单只操作入口：$groupCount 个群、多选 $selecting、$trigger',
    ({ groupCount, selecting, trigger }) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('localStorage', new Storage());
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const assistantGroups = groups().slice(0, groupCount);
      const other = { ...groups()[0], id: '10003' };
      const entry: Conversation = {
        ...other,
        type: 'merged',
        id: 'merged:group-assistant',
        mergedKind: 'groupAssistant',
        title: '群助手',
        avatarUrl: null,
        group: null,
        otherUser: null,
        members: [],
      };
      const pin = vi.fn();
      const navigate = vi.fn();
      const readState = vi.fn();
      const roaming = vi.fn();
      function Probe() {
        return h('output', null, JSON.stringify(useCurrentContentSelection()));
      }
      const render = (pinned: boolean) =>
        act(() =>
          root.render(
            h(
              ContentSelectionProvider,
              null,
              h(
                ConversationDirectoryContext.Provider,
                {
                  value: {
                    ...conversationViewFixture({
                      regular: [other, entry],
                      groupAssistant: assistantGroups.slice(0, 1),
                    }),
                    // 两个群时只加载首个会话，入口数量仍以完整归属集合为准。
                    real: [...assistantGroups.slice(0, 1), other, entry],
                    virtual: [],
                    groupAssistantIds: new Set(assistantGroups.map((row) => row.id)),
                    onVirtual: vi.fn(),
                    onCreate: vi.fn(),
                    onPin: pin,
                    onViewChange: navigate,
                    onReadState: readState,
                    onRoaming: roaming,
                  },
                },
                h(ConversationList, {
                  conversations: [other, entry],
                  activeConversationId: null,
                  preferences: { [entry.id]: { pinned } },
                  drafts: {},
                  onSelect: vi.fn(),
                }),
                h(Probe),
              ),
            ),
          ),
        );
      const open = () => {
        const row = host.querySelector<HTMLElement>(`[data-conversation-id="${entry.id}"]`)!;
        act(() =>
          row.dispatchEvent(
            trigger === 'mouse'
              ? new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
              : new KeyboardEvent('keydown', {
                  key: trigger,
                  shiftKey: trigger === 'F10',
                  bubbles: true,
                  cancelable: true,
                }),
          ),
        );
        expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
          '群助手的会话操作',
        );
        expect(document.querySelector('.weq-conversation-actions-target')?.textContent).toBe(
          `群助手内含 ${groupCount} 个群`,
        );
        expect(document.querySelector('.weq-conversation-actions-target .avatar')).toBeNull();
        expect(host.querySelectorAll('.is-context-target')).toHaveLength(1);
        return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      };
      try {
        render(false);
        if (selecting) {
          act(() => host.querySelector<HTMLButtonElement>('[aria-label="多选会话"]')!.click());
          act(() => host.querySelector<HTMLButtonElement>('[aria-label="全选当前结果"]')!.click());
        }
        const before = host.querySelector('output')!.textContent;
        const actions = open();
        expect(actions.map((node) => node.textContent)).toEqual(['进入群助手', '置顶']);
        act(() => actions[1]!.click());
        expect(pin).toHaveBeenLastCalledWith(entry, true);
        expect(host.querySelector('output')!.textContent).toBe(before);
        render(true);
        const pinnedActions = open();
        expect(pinnedActions.map((node) => node.textContent)).toEqual(['进入群助手', '取消置顶']);
        act(() => pinnedActions[1]!.click());
        expect(pin).toHaveBeenLastCalledWith(entry, false);
        expect(host.querySelector('output')!.textContent).toBe(before);
        const navigationActions = open();
        act(() => navigationActions[0]!.click());
        expect(navigate).toHaveBeenCalledWith('groupAssistant', true);
        expect(host.querySelector('output')!.textContent).toBe(before);
        expect(readState).not.toHaveBeenCalled();
        expect(roaming).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it('定位后生成的临时群会话仍不能出现在主列表，普通群与聚合入口不受影响', () => {
    const [group, other] = groups();
    const assistant: Conversation = {
      ...group,
      type: 'merged' as const,
      id: 'merged:group-assistant',
      mergedKind: 'groupAssistant' as const,
      title: '群助手',
      avatarUrl: null,
      group: null,
      otherUser: null,
      members: [],
    };
    const temporary = { ...group, hidden: false, updatedAt: new Date().toISOString() };
    expect(
      sidebarConversationsWithoutAssistant([temporary, other, assistant], new Set([group.id])),
    ).toEqual([other, assistant]);
    expect(sidebarConversationsWithoutAssistant([temporary, other], new Set())).toEqual([
      temporary,
      other,
    ]);
  });

  it('内部置顶按账号持久化，明确取消可覆盖 QQ 原有置顶，损坏值不影响读取', () => {
    vi.stubGlobal('localStorage', new Storage());
    saveGroupAssistantPins('account-a', { '10001': true, '10002': false });
    expect(loadGroupAssistantPins('account-a')).toEqual({ '10001': true, '10002': false });
    expect(loadGroupAssistantPins('account-b')).toEqual({});
    localStorage.setItem('weq:group-assistant-pins:account-b', '{');
    expect(loadGroupAssistantPins('account-b')).toEqual({});
    localStorage.setItem(
      'weq:group-assistant-pins:account-b',
      '{"10001":true,"10002":"true","wrong":true}',
    );
    expect(loadGroupAssistantPins('account-b')).toEqual({ '10001': true });
  });

  it('右键置顶不打开会话或关闭面板，取消后恢复按时间排序，搜索保留置顶状态', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const conversations = groups();
    const back = vi.fn(),
      select = vi.fn();
    function View() {
      const [pins, setPins] = useState<Record<string, boolean>>({});
      return h(MergedSessionPanel, {
        kind: 'groupAssistant',
        conversations,
        groupAssistantIds: new Set(conversations.map((row) => row.id)),
        groupAssistantPins: pins,
        onGroupAssistantPin: (id, pinned) => setPins((value) => ({ ...value, [id]: pinned })),
        anchorX: 10,
        anchorY: 10,
        onBack: back,
        onSelectConversation: select,
      });
    }
    try {
      act(() => root.render(h(View)));
      expect(host.querySelector('[aria-label="取消群助手内置顶"]')).toBeNull();
      act(() =>
        host
          .querySelector('.weq-merged-popover-item')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      );
      act(() =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((node) => node.textContent === '取消群助手内置顶')!
          .click(),
      );
      expect(back).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(host.querySelector('.is-pinned')).toBeNull();
      act(() => host.querySelector<HTMLButtonElement>('.weq-merged-popover-item')!.click());
      expect(select.mock.calls[0][0].id).toBe('10001');
      act(() =>
        host
          .querySelectorAll('.weq-merged-popover-item')[1]
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      );
      act(() =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((node) => node.textContent === '在群助手内置顶')!
          .click(),
      );
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="搜索群助手会话"]')!.click());
      const input = host.querySelector<HTMLInputElement>('input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '10002',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(host.querySelectorAll('.weq-merged-popover-item')).toHaveLength(1);
      expect(host.querySelector('.is-pinned')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('内部优先显示置顶群，不受较新的普通群消息影响', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const conversations = groups();
    const select = vi.fn();
    try {
      act(() =>
        root.render(
          h(MergedSessionPanel, {
            kind: 'groupAssistant',
            conversations,
            groupAssistantIds: new Set(conversations.map((row) => row.id)),
            anchorX: 10,
            anchorY: 10,
            onBack: vi.fn(),
            onSelectConversation: select,
          }),
        ),
      );
      act(() => host.querySelector<HTMLButtonElement>('.weq-merged-popover-item')!.click());
      expect(select.mock.calls[0][0].id).toBe('10002');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
