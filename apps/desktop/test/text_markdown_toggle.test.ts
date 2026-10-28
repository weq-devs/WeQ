import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autoTextMarkdownBody,
  TextMarkdownContext,
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
  useTextMarkdownStore.setState({ rawKeys: new Set() });
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
      expect(button()).toBeUndefined();
      expect(host.querySelector('#target .qq-md')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('全局关闭或非自动 Markdown 的消息不显示切换入口', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      for (const qqElements of [
        [],
        [{ type: 'markdown', data: { markdownContent: message.body } }],
        [{ type: 'text', data: { textContent: '普通文字' } }],
      ]) {
        act(() => root.render(h(TextMarkdownMenuAction, { message: { ...message, qqElements } })));
        expect(host.textContent).toBe('');
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it('不同会话的同名消息分别保存，重复切换回默认时移除状态', () => {
    const key = textMarkdownKey(message);
    const other = textMarkdownKey({ ...message, conversationId: 'other-conversation' });
    useTextMarkdownStore.getState().toggle(key);
    expect(useTextMarkdownStore.getState().rawKeys.has(key)).toBe(true);
    expect(useTextMarkdownStore.getState().rawKeys.has(other)).toBe(false);
    useTextMarkdownStore.getState().toggle(key);
    expect(useTextMarkdownStore.getState().rawKeys.size).toBe(0);
  });
});
