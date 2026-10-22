import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import type { MergedConversation } from '../src/renderer/src/im-template/template/types';

afterEach(() => vi.unstubAllGlobals());

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

it('群助手默认仅显示未读圆点，开启总数不影响各群数字，无未读时不显示圆点', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  const assistant: MergedConversation = {
    ...base,
    id: 'merged:group-assistant',
    type: 'merged',
    mergedKind: 'groupAssistant',
    title: '群助手',
    avatarUrl: null,
    otherUser: null,
    group: null,
    unreadCount: 8,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (enabled?: boolean, count = 8) =>
    act(() =>
      root.render(
        createElement(
          ContentSelectionProvider,
          null,
          createElement(
            ConversationDirectoryContext.Provider,
            {
              value: {
                virtual: [],
                onVirtual: () => {},
                onCreate: () => {},
                showGroupAssistantMessageCount: enabled,
              },
            },
            createElement(ConversationList, {
              conversations: [
                { ...assistant, unreadCount: count },
                { ...base, unreadCount: 3 },
              ],
              activeConversationId: null,
              preferences: {},
              drafts: {},
              onSelect: () => {},
            }),
          ),
        ),
      ),
    );
  try {
    render();
    expect(host.querySelector('[aria-label="群助手有未读消息"]')).not.toBeNull();
    expect([...host.querySelectorAll('.row-unread')].map((el) => el.textContent)).toEqual(['3']);
    render(true);
    expect(host.querySelector('.row-unread-dot')).toBeNull();
    expect([...host.querySelectorAll('.row-unread')].map((el) => el.textContent)).toContain('8');
    render(false, 0);
    expect(host.querySelector('.row-unread-dot')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('虚拟列表跟随 CSS 行高，手机行高增大和切回桌面后均不重叠', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  let measure = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: (entries: ResizeObserverEntry[]) => void) {}
      observe(target: Element) {
        if (target.matches('.weq-conversation-viewport')) measure = () => this.callback([]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  const rows = [0, 1, 2].map((index) => ({ ...base, id: `fixture-${index}` }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          ContentSelectionProvider,
          null,
          createElement(ConversationList, {
            conversations: rows,
            activeConversationId: null,
            preferences: {},
            drafts: {},
            onSelect: () => {},
          }),
        ),
      ),
    );
    const secondRow = () =>
      host.querySelector<HTMLElement>('[data-conversation-id="fixture-1"]')!.parentElement!;
    expect(secondRow().style.top).toBe('62px');
    const viewport = host.querySelector<HTMLElement>('.weq-conversation-viewport')!;
    viewport.style.setProperty('--weq-conversation-row-height', '76px');
    act(measure);
    expect(secondRow().style.top).toBe('76px');
    expect(secondRow().style.height).toBe('76px');
    viewport.style.removeProperty('--weq-conversation-row-height');
    act(measure);
    expect(secondRow().style.top).toBe('62px');
    expect(secondRow().style.height).toBe('62px');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
