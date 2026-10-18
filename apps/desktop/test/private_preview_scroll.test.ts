import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GapMessagesModal } from '../src/renderer/src/components/compose/GapMessagesModal';
import { renderToStaticMarkup } from 'react-dom/server';
import { GRAY_TIP_KINDS } from '../src/renderer/src/im-template/template/messageRow';
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
it.each([...GRAY_TIP_KINDS, 'groupCallEnded'])(
  '预览里的 %s 复用系统消息行，不输出 XML 普通气泡',
  (kind) => {
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const xml = '<gtip><nor txt="合成系统提示"/></gtip>';
    const message = {
      ...demo.messages[0]!,
      id: 'system-preview',
      body: xml,
      qqElements: [
        {
          type: kind === 'groupCallEnded' ? 'call' : kind,
          data: { grayTipXmlContent: xml, subType: 16 },
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(GapMessagesModal, {
        preview: true,
        embedded: true,
        conversation,
        user: demo.user,
        messages: [message],
        loading: false,
        loadingMore: false,
        error: null,
        hasMore: false,
        moreFailed: false,
        totalCount: 1,
        onLoadMore: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('.weq-system-message-row')).not.toBeNull();
    expect(doc.querySelector('.weq-deleted-bubble')).toBeNull();
    expect(doc.body.textContent).not.toContain('<gtip>');
  },
);

it('预览的普通富消息继续交给宿主消息渲染器', () => {
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((item) => item.type === 'direct')!;
  const render = vi.fn(() => createElement('span', { 'data-rich-preview': true }, '合成富消息'));
  const html = renderToStaticMarkup(
    createElement(GapMessagesModal, {
      preview: true,
      embedded: true,
      conversation,
      user: demo.user,
      messages: [demo.messages[0]!],
      renderers: [{ id: 'rich-preview', match: () => true, render }],
      loading: false,
      loadingMore: false,
      error: null,
      hasMore: false,
      moreFailed: false,
      totalCount: 1,
      onLoadMore: vi.fn(),
      onClose: vi.fn(),
    }),
  );
  expect(html).toContain('data-rich-preview');
  expect(render).toHaveBeenCalledOnce();
});
it.each(['direct', 'group'])('%s 消息预览初次贴底，向上加载并按新增高度保持阅读锚点', (kind) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let height = 2000;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((item) => item.type === kind)!;
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
    title: '预览新消息',
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
    expect(host.querySelector('.weq-compose-title')?.textContent).toBe('预览新消息');
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
