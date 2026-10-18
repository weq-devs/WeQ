import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GapMessagesModal } from '../src/renderer/src/components/compose/GapMessagesModal';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('私聊预览初次贴底，向上加载并按新增高度保持阅读锚点', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let height = 2000;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((item) => item.type === 'direct')!;
  const messages = demo.messages.slice(0, 2).map((message, index) => ({
    ...message,
    id: `preview-${index}`,
    conversationId: conversation.id,
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const more = vi.fn();
  const props = {
    preview: true,
    embedded: true,
    conversation,
    user: demo.user,
    messages,
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: true,
    moreFailed: false,
    totalCount: 2,
    onLoadMore: more,
    onClose: vi.fn(),
  };
  try {
    act(() => root.render(createElement(GapMessagesModal, props)));
    expect(host.querySelector('.weq-private-preview-inline')).not.toBeNull();
    expect(document.querySelector('.weq-window-layer')).toBeNull();
    const scroll = document.querySelector<HTMLElement>('.weq-deleted-scroll')!;
    expect(scroll.scrollTop).toBe(height);
    act(() => {
      scroll.scrollTop = 80;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(more).toHaveBeenCalledOnce();
    act(() => root.render(createElement(GapMessagesModal, { ...props, loadingMore: true })));
    height = 3000;
    const older = { ...messages[0]!, id: 'older' };
    act(() =>
      root.render(
        createElement(GapMessagesModal, {
          ...props,
          messages: [older, ...messages],
          totalCount: 3,
        }),
      ),
    );
    expect(scroll.scrollTop).toBe(1080);
    expect(document.querySelector('.weq-gap-history-top')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
