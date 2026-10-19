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
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import {
  loadGroupAssistantPins,
  saveGroupAssistantPins,
  sidebarConversationsWithoutAssistant,
} from '../src/renderer/src/lib/groupAssistant';

vi.mock('../src/renderer/src/trpc/client', () => {
  const query = { useQuery: () => ({ data: undefined }) };
  return {
    trpc: {
      account: {
        listOfficialAccounts: query,
        listServiceAccounts: query,
        listHiddenSessions: query,
        listDeletedSessions: query,
      },
    },
  };
});
afterEach(() => vi.unstubAllGlobals());

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
  it('主列表全选展开助手内会话并注明数量，两处共享选区且右键可进入多选', () => {
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
    const rows = [...assistantGroups, other, entry];
    const assistantIds = new Set(assistantGroups.map((row) => row.id));
    const select = vi.fn(),
      back = vi.fn(),
      pin = vi.fn();
    function Probe() {
      return h('output', null, JSON.stringify(useCurrentContentSelection()));
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
                  virtual: [],
                  groupAssistantIds: assistantIds,
                  onVirtual: vi.fn(),
                  onCreate: vi.fn(),
                  onPin: pin,
                },
              },
              h(ConversationList, {
                conversations: [other, entry],
                activeConversationId: null,
                preferences: {},
                drafts: {},
                onSelect: select,
              }),
              h(MergedSessionPanel, {
                kind: 'groupAssistant',
                conversations: rows,
                groupAssistantIds: assistantIds,
                anchorX: 10,
                anchorY: 10,
                onBack: back,
                onSelectConversation: select,
              }),
              h(Probe),
            ),
          ),
        ),
      );
      const main = host.querySelector('.weq-conversation-directory')!;
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="多选会话"]')!.click());
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="全选当前结果"]')!.click());
      const selection = () =>
        JSON.parse(host.querySelector('output')!.textContent!).scope.ids as string[];
      expect(selection().sort()).toEqual(['10001', '10002', '10003']);
      expect(main.textContent).toContain('已选 3（含群助手 2）');
      expect(host.querySelectorAll('.weq-merged-popover-row.is-multiselected')).toHaveLength(2);
      act(() => host.querySelector<HTMLButtonElement>('.weq-merged-popover-item')!.click());
      expect(selection()).toHaveLength(2);
      expect(select).not.toHaveBeenCalled();
      expect(back).not.toHaveBeenCalled();
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
      act(() =>
        host
          .querySelector('.weq-merged-popover-item')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      );
      act(() =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((node) => node.textContent === '多选')!
          .click(),
      );
      expect(selection()).toHaveLength(1);
      expect(main.textContent).toContain('已选 1（含群助手 1）');
      const ordinary = main.querySelector<HTMLElement>('[data-conversation-id="10003"]')!;
      act(() =>
        ordinary.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(selection().sort()).toEqual(['10001', '10002', '10003']);
      act(() => main.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
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
