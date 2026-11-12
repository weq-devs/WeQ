import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from './support/templateDemoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { conversationViewFixture } from './support/conversation-view-fixture';
import type { ConversationView } from '../src/renderer/src/lib/conversationViews';
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
  function View() {
    const [selected, setSelected] = useState<string | null>(null);
    const [view, setView] = useState<ConversationView>('regular');
    const [returnToRegular, setReturnToRegular] = useState(false);
    const directory = conversationViewFixture(
      { regular: [regular, merged], groupAssistant: [folded] },
      view,
    );
    const keyword = '课程';
    return h(
      ContentSelectionProvider,
      null,
      !selected &&
        h(SearchDropdown, {
          keyword,
          categories: ['group'],
          onCategoriesChange: vi.fn(),
          quick: {
            conversations: [],
            groups: [
              {
                category: 'group',
                groupCode: folded.id,
                name: folded.group.name,
                remark: '',
                inDirectory: true,
                hasConversation: true,
                conversationView: 'groupAssistant',
                aliases: [],
              },
            ],
            friends: [],
            groupMembers: [],
          },
          quickLoading: false,
          slow: null,
          slowLoading: false,
          onSelect: (hit) => {
            if (hit.category === 'group') {
              setSelected(hit.groupCode);
              setView(hit.conversationView ?? 'regular');
            }
          },
          onMore: vi.fn(),
        }),
      h('output', { 'data-selected': selected, 'data-global-query': keyword, 'data-view': view }),
      h(
        ConversationDirectoryContext.Provider,
        {
          value: {
            ...directory,
            real: rows,
            groupAssistantIds: assistantIds,
            virtual: [],
            onVirtual: vi.fn(),
            onCreate: vi.fn(),
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
          conversations: directory.rows,
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
  it('全局命中进入群助手视图并保留关键词，切回常规不改变已打开的聊天', () => {
    const f = mount();
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
      expect(f.host.querySelector('output')?.getAttribute('data-selected')).toBe('10001');
      expect(f.host.querySelector('output')?.getAttribute('data-global-query')).toBe('课程');
      expect(f.host.querySelector('output')?.getAttribute('data-view')).toBe('groupAssistant');
      expect(f.host.querySelector('[data-conversation-id="10001"]')).not.toBeNull();
      expect(f.host.querySelector('[data-conversation-id="10002"]')).toBeNull();
      expect(f.host.querySelector('[aria-label="返回常规视图"]')).toBeNull();
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="会话视图"]')!.click());
      act(() =>
        [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
          .find((item) => item.textContent === '常规视图')!
          .click(),
      );
      expect(f.host.querySelector('output')?.getAttribute('data-selected')).toBe('10001');
      expect(f.host.querySelector('[data-conversation-id="10001"]')).toBeNull();
      expect(f.host.querySelector('[data-conversation-id="10002"]')).not.toBeNull();
      expect(
        f.host.querySelector('[data-conversation-id="merged:group-assistant"]'),
      ).not.toBeNull();
    } finally {
      f.close();
    }
  });

  it('常规局部搜索只检索平铺会话与聚合名称，进入群助手后才检索内部群', () => {
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
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '群助手',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(f.host.querySelector('[data-conversation-id="10001"]')).toBeNull();
      expect(f.host.querySelector('[data-conversation-id="10002"]')).toBeNull();
      expect(
        f.host.querySelector('[data-conversation-id="merged:group-assistant"]'),
      ).not.toBeNull();
      act(() =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      act(() =>
        f.host
          .querySelector<HTMLButtonElement>('[data-conversation-id="merged:group-assistant"]')!
          .click(),
      );
      expect(f.host.querySelector('[aria-label="返回常规视图"]')).not.toBeNull();
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="搜索会话"]')!.click());
      const assistantInput = f.host.querySelector<HTMLInputElement>(
        '.weq-directory-toolbar input',
      )!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          assistantInput,
          '课程',
        );
        assistantInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(f.host.querySelector('[data-conversation-id="10001"]')).not.toBeNull();
      expect(f.host.querySelector('[data-conversation-id="10002"]')).toBeNull();
    } finally {
      f.close();
    }
  });
});
