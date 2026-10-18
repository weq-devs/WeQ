import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { sidebarConversationsWithoutAssistant } from '../src/renderer/src/lib/groupAssistant';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) => (key === 'useQuery' ? () => ({ data: undefined }) : proxy()),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  const folded = {
    ...base,
    id: '10001',
    group: { ...base.group, id: '10001', name: '课程群助手内' },
  };
  const regular = {
    ...base,
    id: '10002',
    group: { ...base.group, id: '10002', name: '课程普通群' },
  };
  const merged: Conversation = {
    ...base,
    id: 'merged:group-assistant',
    type: 'merged',
    mergedKind: 'groupAssistant',
    title: '群助手',
    group: null,
    otherUser: null,
    members: [],
    avatarUrl: null,
  };
  const rows = [folded, regular, merged];
  const assistantIds = new Set([folded.id]);
  const sidebar = sidebarConversationsWithoutAssistant(rows, assistantIds);
  function View() {
    const [selected, setSelected] = useState<string | null>(null);
    const keyword = '课程';
    return h(
      ContentSelectionProvider,
      null,
      !selected &&
        h(SearchDropdown, {
          keyword,
          categories: ['conversation'],
          onCategoriesChange: vi.fn(),
          quick: {
            conversations: [
              {
                category: 'conversation',
                targetUid: folded.id,
                targetUin: folded.id,
                chatType: 2,
                name: folded.group.name,
                typeLabel: '群聊',
              },
            ],
            friends: [],
            groupMembers: [],
          },
          quickLoading: false,
          slow: null,
          slowLoading: false,
          onSelect: (hit) => {
            if (hit.category === 'conversation') setSelected(hit.targetUid);
          },
          onMore: vi.fn(),
        }),
      h('output', { 'data-selected': selected, 'data-global-query': keyword }),
      h(
        ConversationDirectoryContext.Provider,
        {
          value: {
            real: rows,
            groupAssistantIds: assistantIds,
            virtual: [],
            onVirtual: vi.fn(),
            onCreate: vi.fn(),
          },
        },
        h(ConversationList, {
          // 模拟全局关键词未清除时传入完整会话，以及普通情况下传入过滤列表。
          conversations: selected ? rows : sidebar,
          activeConversationId: selected,
          preferences: {},
          drafts: {},
          onSelect: setSelected,
        }),
      ),
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(View)));
  return {
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('群助手搜索隔离', () => {
  it('全局命中可打开群聊并保留关键词，但不会把群放进主会话列表', () => {
    const f = mount();
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
      expect(f.host.querySelector('output')?.getAttribute('data-selected')).toBe('10001');
      expect(f.host.querySelector('output')?.getAttribute('data-global-query')).toBe('课程');
      expect(f.host.querySelector('[data-conversation-id="10001"]')).toBeNull();
      expect(f.host.querySelector('[data-conversation-id="10002"]')).not.toBeNull();
      expect(
        f.host.querySelector('[data-conversation-id="merged:group-assistant"]'),
      ).not.toBeNull();
    } finally {
      f.close();
    }
  });

  it('列表局部搜索读取完整目录时也不显示群助手成员', () => {
    const f = mount();
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="搜索会话"]')!.click());
      const input = f.host.querySelector<HTMLInputElement>('.weq-directory-toolbar input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '课程',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(f.host.querySelector('[data-conversation-id="10001"]')).toBeNull();
      expect(f.host.querySelector('[data-conversation-id="10002"]')).not.toBeNull();
    } finally {
      f.close();
    }
  });
});
