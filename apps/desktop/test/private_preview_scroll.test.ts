import { act, createElement, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GapMessagesModal } from '../src/renderer/src/components/compose/GapMessagesModal';
import { renderToStaticMarkup } from 'react-dom/server';
import { GRAY_TIP_KINDS } from '../src/renderer/src/im-template/template/messageRow.shared';
import type { MessageRenderer } from '../src/renderer/src/im-template/template/messageRenderers';
import { createTemplateDemoData } from './support/templateDemoData';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
import { ReplyJumpContext } from '../src/renderer/src/state/messageContext';

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

it('完整预览按主时间线合并；本群发言和隐藏消息两侧独立保留作者', () => {
  acceptPreferences(
    { revision: 1, values: { groupConsecutiveMessages: true }, records: {} },
    false,
  );
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((item) => item.type === 'group')!;
  const messages = [0, 1, 2].map((index) => ({
    ...demo.messages[0]!,
    id: `preview-group-${index}`,
    msgSeq: String(index + 1),
    conversationId: conversation.id,
    createdAt: new Date(Date.UTC(2026, 10, 28, 4, 0, index)).toISOString(),
  }));
  const props = {
    preview: true,
    embedded: true,
    conversation,
    user: demo.user,
    messages,
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    moreFailed: false,
    totalCount: messages.length,
    onLoadMore: vi.fn(),
    onClose: vi.fn(),
  };
  const render = (overrides = {}) =>
    new DOMParser().parseFromString(
      renderToStaticMarkup(createElement(GapMessagesModal, { ...props, ...overrides })),
      'text/html',
    );
  try {
    const full = render();
    expect(full.querySelectorAll('.message-time-divider')).toHaveLength(1);
    expect(full.querySelectorAll('[data-message-group]')).toHaveLength(3);

    const filtered = render({ independent: true });
    expect(filtered.querySelectorAll('[data-message-group]')).toHaveLength(0);
    expect(filtered.querySelectorAll('.weq-message-provenance time')).toHaveLength(3);

    const hidden = render({ hiddenIds: new Set(['preview-group-1']) });
    expect(hidden.querySelector('[data-message-id="preview-group-1"]')).toBeNull();
    expect(hidden.querySelectorAll('[data-message-group]')).toHaveLength(0);
  } finally {
    acceptPreferences({ revision: 1, values: {}, records: {} }, false);
  }
});

it('预览的引用优先定位可见原文，隐藏后交给来源会话处理', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((item) => item.type === 'group')!;
  const original = {
    ...demo.messages[0]!,
    id: 'preview-original',
    msgId: '512',
    msgSeq: '70',
    qqElements: [{ type: 'text', data: { textContent: '被引用的原文' } }],
  };
  const reply = { ...demo.messages[1]!, id: 'preview-reply', msgId: '513', msgSeq: '71' };
  const locateSource = vi.fn(async () => true);
  function QuoteProbe() {
    const jump = useContext(ReplyJumpContext);
    return createElement(
      'button',
      { type: 'button', onClick: () => void jump({ seq: '70' }) },
      '定位引用',
    );
  }
  const renderers: MessageRenderer[] = [
    {
      id: 'quote-probe',
      match: ({ message }) => message.id === reply.id,
      render: () => createElement(QuoteProbe),
    },
  ];
  const props = {
    preview: true,
    embedded: true,
    conversation,
    user: demo.user,
    messages: [original, reply],
    renderers,
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    moreFailed: false,
    totalCount: 2,
    onLoadMore: vi.fn(),
    onClose: vi.fn(),
    onLocateReply: locateSource,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const clickQuote = () =>
    act(async () =>
      host
        .querySelector<HTMLButtonElement>('[data-message-id="preview-reply"] button:last-child')!
        .click(),
    );
  try {
    await act(async () => root.render(createElement(GapMessagesModal, props)));
    await clickQuote();
    expect(host.querySelector('[data-message-id="preview-original"]')?.classList).toContain(
      'weq-reply-target-flash',
    );
    expect(locateSource).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        createElement(GapMessagesModal, {
          ...props,
          hiddenIds: new Set([original.id]),
        }),
      ),
    );
    await clickQuote();
    expect(locateSource).toHaveBeenCalledWith({ seq: '70' });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each(['direct', 'group'])('%s 会话预览右键精确定位原消息，关闭菜单不触发定位', async (kind) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((item) => item.type === kind)!;
  const message = {
    ...demo.messages[0]!,
    id: '9007199254740999',
    msgId: '9007199254740999',
    msgSeq: '123',
  };
  const locate = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
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
          onLocateMessage: locate,
        }),
      ),
    );
    const open = () =>
      act(() =>
        host
          .querySelector(`[data-message-id="${message.id}"] .message-bubble`)!
          .dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }),
          ),
      );
    open();
    const locateButton = document.querySelector<HTMLButtonElement>('[aria-label="定位原消息"]');
    expect(locateButton).not.toBeNull();
    await act(async () => locateButton!.click());
    expect(locate).toHaveBeenCalledOnce();
    expect(locate).toHaveBeenCalledWith({ seq: '123', msgId: message.msgId });
    open();
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      ),
    );
    expect(locate).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
it('会话预览的引用和批量转发交给来源会话，多选跳过隐藏消息', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((item) => item.type === 'group')!;
  const messages = [1, 2, 3].map((seq) => ({
    ...demo.messages[0]!,
    id: String(100 + seq),
    msgId: String(100 + seq),
    msgSeq: String(seq),
    conversationId: conversation.id,
    qqElements: [{ type: 'text', data: { textContent: `消息 ${seq}` } }],
  }));
  const quote = vi.fn();
  const forward = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const bubble = (index: number) =>
    host.querySelector<HTMLElement>(`[data-message-id="${messages[index]!.id}"] .message-bubble`)!;
  const open = () =>
    act(() => bubble(0).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
  const clickAction = (label: string, role = 'menu') =>
    act(async () =>
      document
        .querySelector<HTMLButtonElement>(`[role="${role}"] [aria-label="${label}"]`)!
        .click(),
    );
  try {
    await act(async () =>
      root.render(
        createElement(GapMessagesModal, {
          preview: true,
          embedded: true,
          conversation,
          user: demo.user,
          messages,
          hiddenIds: new Set([messages[1]!.id]),
          loading: false,
          loadingMore: false,
          error: null,
          hasMore: false,
          moreFailed: false,
          totalCount: messages.length,
          onLoadMore: vi.fn(),
          onClose: vi.fn(),
          actions: { conversation, quote, forward },
        }),
      ),
    );
    open();
    expect(quote).not.toHaveBeenCalled();
    await clickAction('引用');
    expect(quote.mock.calls).toEqual([[messages[0]]]);
    open();
    await clickAction('多选');
    act(() => bubble(2).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    await clickAction('转发', 'toolbar');
    expect(forward.mock.calls).toEqual([[[messages[0], messages[2]]]]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
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
    if (kind === 'group') {
      const firstMessage = scroll.querySelector<HTMLElement>('[data-message-id="preview-0"]')!;
      vi.spyOn(firstMessage, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(0, height === 3000 ? 712 : 12, 100, 25),
      );
    }
    act(() => {
      scroll.scrollTop = 80;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(more).toHaveBeenCalledOnce();
    act(() => root.render(createElement(GapMessagesModal, { ...props, loadingMore: true })));
    act(() => {
      scroll.scrollTop = 320;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
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
    expect(scroll.scrollTop).toBe(kind === 'group' ? 1020 : 1320);
    expect(document.querySelector('.weq-gap-history-top')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
