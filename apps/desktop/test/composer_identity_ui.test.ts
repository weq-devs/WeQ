import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from './support/templateDemoData';
import {
  focusComposerEnd,
  serializeComposer,
} from '../src/renderer/src/im-template/template/composer.shared';
import { buildComposerSendPlan } from '../src/renderer/src/im-template/template/composerSend';
import { resolveMentionLabels } from '../src/renderer/src/lib/mentionIdentity';
import { mentionClipboardHtml } from '../src/renderer/src/lib/mentionClipboard';
import type { RepeatElement } from '../src/renderer/src/lib/messageRepeat';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
import type { PreferencePatch } from '@weq/service/client-preferences';

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
  act(() =>
    acceptPreferences({ epoch: crypto.randomUUID(), revision: 0, values: {}, records: {} }, false),
  );
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
              memberLevel: 42,
              levelName: '活跃成员',
              customTitle: '组长',
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

function setPreferences(values: PreferencePatch) {
  act(() =>
    acceptPreferences({ epoch: crypto.randomUUID(), revision: 0, values, records: {} }, false),
  );
}

async function mountQuoted(f: ReturnType<typeof fixture>, self = false, draft = '原有草稿') {
  const sender = self
    ? f.props.user
    : f.props.conversation.type === 'group'
      ? f.props.conversation.members[0]!
      : f.props.conversation.otherUser!;
  await act(async () =>
    f.root.render(
      createElement(ChatPane, {
        ...f.props,
        draft,
        messages: [
          {
            id: 'quoted-message',
            conversationId: f.props.conversation.id,
            senderId: sender.id,
            msgSeq: '120',
            body: '原消息正文',
            createdAt: '2026-10-17T06:00:00Z',
          },
        ],
      }),
    ),
  );
  quoteMessage(f.host);
  return f.host.querySelector<HTMLElement>('.composer-editor')!;
}

function quoteMessage(host: HTMLElement) {
  act(() =>
    host
      .querySelector('[data-message-id="quoted-message"] .message-bubble')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="引用"]')!.click());
}

function activeQuote(host: HTMLElement) {
  return host.querySelector('.composer-quote-slot:not([inert]) .composer-quote');
}

describe('真实输入区与 +1 操作', () => {
  it.each([
    ['group', true, false, true],
    ['group', false, false, false],
    ['group', true, true, false],
    ['direct', true, false, false],
  ] as const)('%s 自动提及 %s / 引用自己 %s', async (type, enabled, self, expected) => {
    const f = fixture(type);
    try {
      setPreferences({ autoMentionOnQuote: enabled });
      const editor = await mountQuoted(f, self, '原有 @草稿');
      expect(editor.querySelectorAll('[data-weq-at-uid]').length).toBe(Number(expected));
      expect(editor.textContent).toContain('原有 @草稿');
      if (expected) {
        const plan = buildComposerSendPlan({
          body: serializeComposer(editor),
          locals: [],
          superStickers: new Map(),
        });
        expect(plan).toMatchObject({
          kind: 'elements',
          elements: expect.arrayContaining([
            { kind: 'at', textContent: '@公开昵称', atTargetUid: 'u_member', atTargetUin: 12345 },
          ]),
        });
        quoteMessage(f.host);
        expect(editor.querySelectorAll('[data-weq-at-uid]').length).toBe(1);
        act(() => editor.querySelector('[data-weq-at-uid]')!.remove());
        expect(editor.querySelector('[data-weq-at-uid]')).toBeNull();
        expect(f.host.querySelector('.composer-quote')).not.toBeNull();
      }
      expect(f.props.onSend).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it.each(['group', 'direct'] as const)(
    '%s 空输入框单次退格可移除引用，关闭设置保留引用',
    async (type) => {
      const f = fixture(type);
      try {
        const editor = await mountQuoted(f, false, '');
        act(() => {
          focusComposerEnd(editor);
          editor.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
          );
        });
        expect(activeQuote(f.host)).toBeNull();
        quoteMessage(f.host);
        setPreferences({ backspaceRemovesQuote: false });
        act(() => {
          focusComposerEnd(editor);
          editor.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
          );
        });
        expect(activeQuote(f.host)).not.toBeNull();
      } finally {
        f.dispose();
      }
    },
  );

  it.each([
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
  ])('连续退格、输入法与组合键不移除引用：%s', async (options) => {
    const f = fixture();
    try {
      const editor = await mountQuoted(f, false, '');
      act(() => {
        focusComposerEnd(editor);
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Backspace',
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        );
      });
      expect(activeQuote(f.host)).not.toBeNull();
    } finally {
      f.dispose();
    }
  });

  it('全选正文删除只删除正文，下一次独立退格才移除引用', async () => {
    const f = fixture();
    try {
      const editor = await mountQuoted(f);
      act(() => {
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        const event = new KeyboardEvent('keydown', {
          key: 'Backspace',
          bubbles: true,
          cancelable: true,
        });
        editor.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        range.deleteContents();
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
      expect(activeQuote(f.host)).not.toBeNull();
      act(() => {
        focusComposerEnd(editor);
        editor.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
        );
      });
      expect(activeQuote(f.host)).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it('群消息名称、等级与头衔独立实时变化，不改引用中的发送者名称', async () => {
    const f = fixture();
    try {
      await mountQuoted(f);
      const heading = () =>
        f.host.querySelector('[data-message-id="quoted-message"] .weq-message-heading')!
          .textContent;
      expect(heading()).toContain('我的备注');
      expect(heading()).toContain('Lv42 · 组长');
      setPreferences({ showGroupMemberName: false });
      expect(heading()).not.toContain('我的备注');
      expect(heading()).toContain('Lv42 · 组长');
      expect(f.host.querySelector('.composer-quote strong')?.textContent).toBe('我的备注');
      setPreferences({ showGroupMemberLevel: false });
      expect(heading()).toContain('我的备注');
      expect(heading()).toContain('组长');
      expect(heading()).not.toContain('Lv42');
      setPreferences({ showGroupMemberTitle: false });
      expect(heading()).toContain('Lv42 · 活跃成员');
      expect(heading()).not.toContain('组长');
      setPreferences({
        showGroupMemberName: false,
        showGroupMemberLevel: false,
        showGroupMemberTitle: false,
      });
      expect(f.host.querySelector('[data-message-id="quoted-message"] .message-name')).toBeNull();
    } finally {
      f.dispose();
    }
  });
  it('普通输入提示发送，中文选词的 Enter 不误发，点击发送后可继续输入', async () => {
    const f = fixture('direct');
    try {
      await act(async () => f.root.render(createElement(ChatPane, f.props)));
      const editor = f.host.querySelector<HTMLElement>('.composer-editor')!;
      expect(editor.getAttribute('enterkeyhint')).toBe('send');
      act(() => {
        focusComposerEnd(editor);
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            keyCode: 229,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(f.props.onSend).not.toHaveBeenCalled();
      act(() =>
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(f.props.onSend).not.toHaveBeenCalled();
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.composer > .composer-send')!.click(),
      );
      expect(f.props.onSend).toHaveBeenCalledOnce();
      expect(f.props.onSend).toHaveBeenCalledWith('原有草稿', undefined);
      expect(document.activeElement).toBe(editor);
      expect(editor.textContent).toBe('');
      expect(f.host.querySelector<HTMLButtonElement>('.composer > .composer-send')!.disabled).toBe(
        true,
      );
    } finally {
      f.dispose();
    }
  });
  it.each(['group', 'direct'] as const)(
    '%s 引用条复用消息行解析的本地发送者，不要求消息自带 sender',
    async (type) => {
      const f = fixture(type);
      const sender =
        f.props.conversation.type === 'group'
          ? f.props.conversation.members[0]!
          : f.props.conversation.otherUser!;
      try {
        await act(async () =>
          f.root.render(
            createElement(ChatPane, {
              ...f.props,
              messages: [
                {
                  id: 'quoted-message',
                  conversationId: f.props.conversation.id,
                  senderId: sender.id,
                  msgSeq: '120',
                  body: '原消息正文',
                  createdAt: '2026-10-17T06:00:00Z',
                },
              ],
            }),
          ),
        );
        act(() => {
          f.host
            .querySelector('[data-message-id="quoted-message"] .message-bubble')!
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });
        const reply = document.querySelector<HTMLButtonElement>('[aria-label="引用"]');
        expect(reply).not.toBeNull();
        act(() => reply!.click());
        expect(f.host.querySelector('.composer-quote strong')?.textContent).toBe(
          sender.displayName,
        );
        expect(f.props.onSend).not.toHaveBeenCalled();
      } finally {
        f.dispose();
      }
    },
  );

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
    '%s 略过灰条和本地删除，在最新相同消息旁显示一个 +1，防连点且不动草稿',
    async (type) => {
      const f = fixture(type);
      let finish: () => void = () => {};
      const repeat = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const messages = ['first', 'poke', 'last', 'tail-tip'].map((id) => ({
        id,
        conversationId: f.props.conversation.id,
        senderId: f.props.user.id,
        body: '相同',
        createdAt: '2026-10-17T06:00:00Z',
        qqElements:
          id === 'poke' || id === 'tail-tip'
            ? [{ type: 'grayTipPoke' }]
            : [{ type: 'text', data: { textContent: '相同' } }],
      }));
      try {
        await act(async () =>
          f.root.render(createElement(ChatPane, { ...f.props, messages, onRepeatMessage: repeat })),
        );
        // 私聊输入框不再有「发送正在输入状态」开关按钮，会话类型都不渲染它。
        expect(f.host.querySelector('.weq-qq-typing-toggle')).toBeNull();
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
              messages: [
                messages[0]!,
                {
                  ...messages[0]!,
                  id: 'deleted',
                  body: '不同',
                  qqElements: [{ type: 'text', data: { textContent: '不同' } }],
                },
                ...messages.slice(1),
              ],
              deletedIds: new Set(['deleted']),
              onRepeatMessage: repeat,
            }),
          ),
        );
        expect(f.host.querySelector('[data-message-id="last"] .weq-message-repeat')).not.toBeNull();
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
