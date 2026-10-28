import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autoTextMarkdownBody,
  TextMarkdownContext,
  textMarkdownBody,
  textMarkdownKey,
  useTextMarkdownStore,
} from '../src/renderer/src/state/textMarkdown';
import { TextMarkdownMenuAction } from '../src/renderer/src/components/TextMarkdownMenuAction';
import { qqMessageRenderer } from '../src/renderer/src/components/QqMessageContent';
import { MessageContextMenu } from '../src/renderer/src/im-template/template/messageContextMenu';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Message } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});

afterEach(() => {
  useTextMarkdownStore.setState({ modes: new Map() });
  vi.unstubAllGlobals();
});

const demo = createTemplateDemoData();
const conversation = demo.conversations.find((row) => row.type === 'direct')!;
const message: Message = {
  id: 'markdown-fixture',
  conversationId: conversation.id,
  senderId: demo.user.id,
  createdAt: '2026-10-29T01:00:00Z',
  body: '**合成粗体**',
  qqElements: [{ type: 'text', data: { textContent: '**合成粗体**' } }],
};

describe('单条消息 Markdown 显示切换', () => {
  it('只认领纯文本 Markdown，不认领引用、表情、原生 Markdown 或普通文字', () => {
    expect(autoTextMarkdownBody(message.qqElements!)).toBe(message.body);
    expect(
      autoTextMarkdownBody([
        { type: 'text', data: { textContent: '**合成' } },
        { type: 'text', data: { textContent: '粗体**' } },
      ]),
    ).toBe(message.body);
    for (const type of ['reply', 'face', 'at', 'markdown', 'ark', 'multiMsg']) {
      expect(autoTextMarkdownBody([...message.qqElements!, { type }])).toBeNull();
    }
    expect(autoTextMarkdownBody([])).toBeNull();
    expect(autoTextMarkdownBody([{ type: 'text', data: { textContent: '普通文字' } }])).toBeNull();
  });

  it('右键菜单双向切换，关闭菜单、重新挂载后仍保留单条选择', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const close = vi.fn();
    const other = { ...message, id: 'another-message' };
    const render = (enabled = true) =>
      root.render(
        h(
          TextMarkdownContext.Provider,
          { value: enabled },
          h(
            'section',
            { id: 'target' },
            qqMessageRenderer.render({ message, conversation, mine: true }),
          ),
          h(
            'section',
            { id: 'other' },
            qqMessageRenderer.render({ message: other, conversation, mine: true }),
          ),
          h(MessageContextMenu, {
            state: { message, x: 100, y: 100 },
            onCopy: vi.fn(),
            onClose: close,
          }),
        ),
      );
    try {
      await act(async () => render());
      expect(host.querySelector('#target [data-streamdown="strong"]')?.textContent).toBe(
        '合成粗体',
      );
      const button = () =>
        [...host.querySelectorAll<HTMLButtonElement>('.message-context-menu button')].find((item) =>
          item.textContent?.includes('显示'),
        )!;
      expect(button().textContent).toBe('显示原文');
      await act(async () => button().click());
      expect(close).toHaveBeenCalledOnce();
      expect(host.querySelector('#target .qq-md')).toBeNull();
      expect(host.querySelector('#target')?.textContent).toBe(message.body);
      expect(host.querySelector('#other [data-streamdown="strong"]')?.textContent).toBe('合成粗体');
      expect(button().textContent).toBe('显示 Markdown');
      await act(async () => root.render(null));
      await act(async () => render());
      expect(host.querySelector('#target .qq-md')).toBeNull();
      expect(button().textContent).toBe('显示 Markdown');
      await act(async () => button().click());
      expect(host.querySelector('#target [data-streamdown="strong"]')?.textContent).toBe(
        '合成粗体',
      );
      expect(button().textContent).toBe('显示原文');
      await act(async () => render(false));
      expect(button().textContent).toBe('显示原文');
      expect(host.querySelector('#target .qq-md')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('非纯文本或空白消息不显示切换入口', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      for (const qqElements of [
        [],
        [{ type: 'markdown', data: { markdownContent: message.body } }],
        [{ type: 'text', data: { textContent: ' \n ' } }],
      ]) {
        act(() => root.render(h(TextMarkdownMenuAction, { message: { ...message, qqElements } })));
        expect(host.textContent).toBe('');
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([
    '**合成粗体**',
    '_斜体_',
    '`行内代码`',
    '标题\n====',
    '|甲|乙|\n|---|---|\n|一|二|',
    '普通文字',
    'https://example.invalid/fixture',
  ])('关闭自动渲染后仍可手动渲染：%s', async (body) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const current = {
      ...message,
      body,
      qqElements: [{ type: 'text', data: { textContent: body } }],
    };
    expect(textMarkdownBody(current.qqElements)).toBe(body);
    const host = document.createElement('div');
    const root = createRoot(host);
    const button = () => host.querySelector<HTMLButtonElement>('button[title^="显示"]')!;
    const render = (automatic: boolean) =>
      root.render(
        h(
          TextMarkdownContext.Provider,
          { value: automatic },
          h(
            'section',
            {},
            qqMessageRenderer.render({ message: current, conversation, mine: true }),
          ),
          h(TextMarkdownMenuAction, { message: current }),
        ),
      );
    try {
      await act(async () => render(false));
      expect(host.querySelector('.qq-md')).toBeNull();
      expect(button().textContent).toBe('显示 Markdown');
      await act(async () => button().click());
      expect(host.querySelector('.qq-md')).not.toBeNull();
      expect(button().textContent).toBe('显示原文');
      await act(async () => button().click());
      expect(host.querySelector('.qq-md')).toBeNull();
      expect(host.querySelector('section')?.textContent).toBe(body);
      await act(async () => render(true));
      expect(host.querySelector('.qq-md')).toBeNull();
      expect(button().textContent).toBe('显示 Markdown');
    } finally {
      act(() => root.unmount());
    }
  });

  it('不同会话的同名消息分别保存，显式选择优先于自动设置', () => {
    const key = textMarkdownKey(message);
    const other = textMarkdownKey({ ...message, conversationId: 'other-conversation' });
    useTextMarkdownStore.getState().setRendered(key, false);
    expect(useTextMarkdownStore.getState().modes.get(key)).toBe(false);
    expect(useTextMarkdownStore.getState().modes.get(other)).toBeUndefined();
    useTextMarkdownStore.getState().setRendered(key, true);
    expect(useTextMarkdownStore.getState().modes.get(key)).toBe(true);
  });
});
