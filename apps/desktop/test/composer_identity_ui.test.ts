import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  focusComposerEnd,
  serializeComposer,
} from '../src/renderer/src/im-template/template/composer';
import { buildComposerSendPlan } from '../src/renderer/src/im-template/template/composerSend';
import { resolveMentionLabels } from '../src/renderer/src/lib/mentionIdentity';
import { mentionClipboardHtml } from '../src/renderer/src/lib/mentionClipboard';
import type { RepeatElement } from '../src/renderer/src/lib/messageRepeat';

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
afterEach(() => vi.unstubAllGlobals());

function fixture(type: 'group' | 'direct' = 'group') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const source = demo.conversations.find((conversation) => conversation.type === type)!;
  const conversation =
    type === 'group'
      ? {
          ...source,
          members: [
            {
              ...demo.user,
              id: 'u_member',
              username: '成员',
              displayName: '我的备注',
              nick: '公开昵称',
              identityValue: '12345',
              role: 'member',
              joinedAt: '',
            },
          ],
        }
      : source;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    user: demo.user,
    conversation,
    messages: [],
    loading: false,
    sendAvailable: true,
    preference: undefined,
    onSend: vi.fn(async () => {}),
    draft: '原有草稿',
    onDraftChange: vi.fn(),
    onDraftClear: vi.fn(),
    onBack: vi.fn(),
  };
  return {
    host,
    root,
    props,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('真实输入区与 +1 操作', () => {
  it.each(['group', 'direct'] as const)('%s 头像菜单仅在群聊提供提及', async (type) => {
    const f = fixture(type);
    try {
      await act(async () =>
        f.root.render(
          createElement(ChatPane, {
            ...f.props,
            messages: [
              {
                id: 'avatar-message',
                conversationId: f.props.conversation.id,
                senderId: f.props.user.id,
                body: '正文',
                createdAt: '2026-10-17T06:00:00Z',
              },
            ],
          }),
        ),
      );
      act(() => {
        f.host
          .querySelector('.message-avatar-button, .message-avatar-wrap')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      const menu = document.querySelector('.avatar-context-menu')!;
      expect(menu).not.toBeNull();
      const mention = menu.querySelector<HTMLButtonElement>('[title="在输入框里 @ 这个人"]');
      expect(Boolean(mention)).toBe(type === 'group');
      expect(menu.textContent).toContain('戳一戳');
      if (mention) {
        act(() => mention.click());
        expect(f.host.querySelector('.composer-editor [data-weq-at-uid]')).not.toBeNull();
      }
    } finally {
      f.dispose();
    }
  });

  it('私聊输入 @ 不展开成员列表，粘贴提及只插入普通文字', async () => {
    const f = fixture('direct');
    const resolve = vi.fn(async (elements: RepeatElement[]) => elements);
    try {
      await act(async () =>
        f.root.render(createElement(ChatPane, { ...f.props, onResolveMentions: resolve })),
      );
      const editor = f.host.querySelector<HTMLElement>('.composer-editor')!;
      act(() => {
        editor.textContent = '@';
        focusComposerEnd(editor);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
      expect(f.host.querySelector('[role="listbox"]')).toBeNull();
      const rich = mentionClipboardHtml([
        { type: 'at', data: { atTargetUid: 'u_member', textContent: '@昵称' } },
      ])!;
      const data = new DataTransfer();
      data.setData('text/html', rich.html);
      data.setData('text/plain', rich.text);
      await act(async () => {
        editor.textContent = '';
        focusComposerEnd(editor);
        editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(editor.querySelector('[data-weq-at-uid]')).toBeNull();
      expect(serializeComposer(editor)).toBe('@昵称');
    } finally {
      f.dispose();
    }
  });

  it('输入 @ 展示成员，粘贴后按 ID 重命名并发出提及 token', async () => {
    const f = fixture();
    try {
      await act(async () =>
        f.root.render(
          createElement(ChatPane, {
            ...f.props,
            onResolveMentions: async (elements) =>
              resolveMentionLabels(elements, [{ uid: 'u_member', nick: '公开昵称' }]),
          }),
        ),
      );
      const editor = f.host.querySelector<HTMLElement>('.composer-editor')!;
      act(() => {
        editor.textContent = '@';
        focusComposerEnd(editor);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
      expect(f.host.querySelector('[role="listbox"]')?.textContent).toContain('我的备注');
      act(() => f.host.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')!.click());
      expect(editor.querySelector('[data-weq-at-uid="u_member"]')?.textContent).toBe('@公开昵称');
      const rich = mentionClipboardHtml([
        { type: 'at', data: { atTargetUid: 'u_member', textContent: '@原作者备注' } },
      ])!;
      const data = new DataTransfer();
      data.setData('text/html', rich.html);
      data.setData('text/plain', rich.text);
      await act(async () => {
        editor.textContent = '';
        focusComposerEnd(editor);
        editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
      });
      expect(editor.querySelector('[data-weq-at-uid="u_member"]')?.textContent).toBe('@公开昵称');
      expect(
        buildComposerSendPlan({
          body: serializeComposer(editor),
          locals: [],
          superStickers: new Map(),
        }),
      ).toMatchObject({
        kind: 'elements',
        elements: [{ kind: 'at', atTargetUid: 'u_member', textContent: '@公开昵称' }],
      });
    } finally {
      f.dispose();
    }
  });
  it.each(['group', 'direct'] as const)(
    '%s 最新相同消息旁显示一个 +1，防连点且不动草稿',
    async (type) => {
      const f = fixture(type);
      let finish: () => void = () => {};
      const repeat = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const messages = ['first', 'last'].map((id) => ({
        id,
        conversationId: f.props.conversation.id,
        senderId: f.props.user.id,
        body: '相同',
        createdAt: '2026-10-17T06:00:00Z',
        qqElements: [{ type: 'text', data: { textContent: '相同' } }],
      }));
      try {
        await act(async () =>
          f.root.render(createElement(ChatPane, { ...f.props, messages, onRepeatMessage: repeat })),
        );
        const typingButton = f.host.querySelector('.weq-qq-typing-toggle');
        if (type === 'direct') {
          expect(typingButton?.parentElement?.classList.contains('composer-tools')).toBe(true);
          expect(typingButton?.parentElement?.lastElementChild).toBe(typingButton);
        } else {
          expect(typingButton).toBeNull();
        }
        const buttons = f.host.querySelectorAll<HTMLButtonElement>('.weq-message-repeat');
        expect(buttons.length).toBe(1);
        expect(buttons[0]?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(
          'last',
        );
        act(() => {
          buttons[0]!.click();
          buttons[0]!.click();
        });
        expect(repeat).toHaveBeenCalledOnce();
        expect(f.host.querySelector('.composer-editor')?.textContent).toBe('原有草稿');
        await act(async () => finish());
        await act(async () =>
          f.root.render(
            createElement(ChatPane, {
              ...f.props,
              messages,
              atLatest: false,
              onRepeatMessage: repeat,
            }),
          ),
        );
        expect(f.host.querySelector('.weq-message-repeat')).toBeNull();
      } finally {
        finish();
        f.dispose();
      }
    },
  );
});
