import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { MessageContextMenu } from '../src/renderer/src/im-template/template/messageContextMenu';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import type { Message } from '../src/renderer/src/im-template/template/types';

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

const base = createTemplateDemoData().messages[0]!;

afterEach(() => vi.unstubAllGlobals());

describe('消息菜单 +1', () => {
  it('点击重发右键选中的原消息，离线或发送期间禁用，不可发送消息隐藏', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onRepeat = vi.fn();
    const normal: Message = {
      ...base,
      qqElements: [{ type: 'text', data: { textContent: '正文' } }],
    };
    async function render(message = normal, reason: string | null = null, enabled = true) {
      await act(async () => {
        root.render(
          createElement(MessageContextMenu, {
            state: { message, x: 10, y: 10 },
            onCopy: vi.fn(),
            onRepeat: enabled ? onRepeat : undefined,
            repeatBlockedReason: reason,
          }),
        );
      });
      return [...host.querySelectorAll('button')].find((button) => button.textContent === '+1');
    }
    try {
      const button = await render();
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(onRepeat).toHaveBeenCalledOnce();
      expect(onRepeat).toHaveBeenCalledWith(normal);
      for (const reason of ['QQ 未在线', '正在发送消息，请稍候']) {
        const disabled = await render(normal, reason);
        expect(disabled?.disabled).toBe(true);
        expect(disabled?.title).toBe(reason);
        disabled?.click();
      }
      expect(onRepeat).toHaveBeenCalledTimes(1);
      for (const type of ['grayTipPoke', 'wallet', 'call']) {
        expect(await render({ ...normal, qqElements: [{ type, data: {} }] })).toBeUndefined();
      }
      expect(await render(normal, null, false)).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(['group', 'direct'] as const)(
    '%s 历史消息右键与自动按钮共用重发，发送时锁定且保留草稿',
    async (type) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('localStorage', new Storage());
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const demo = createTemplateDemoData();
      const conversation = demo.conversations.find((item) => item.type === type)!;
      const history: Message = {
        ...base,
        id: 'history',
        conversationId: conversation.id,
        body: '历史正文',
        qqElements: [{ type: 'text', data: { textContent: '历史正文' } }],
      };
      const latest = {
        ...history,
        id: 'latest',
        body: '相同正文',
        qqElements: [{ type: 'text', data: { textContent: '相同正文' } }],
      };
      let finish = () => {};
      const onRepeatMessage = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const onDraftChange = vi.fn();
      const onDraftClear = vi.fn();
      const props = {
        user: demo.user,
        conversation,
        messages: [history, { ...latest, id: 'previous' }, latest],
        draft: '保留草稿',
        onSend: vi.fn(),
        onDraftChange,
        onDraftClear,
        onBack: vi.fn(),
        onRepeatMessage,
        sendAvailable: true,
      };
      const menuButton = () =>
        [...host.querySelectorAll<HTMLButtonElement>('.message-context-menu button')].find(
          (button) => button.textContent === '+1',
        );
      const openMenu = async () => {
        await act(async () => {
          host
            .querySelector('[data-message-id="history"] .message-bubble')!
            .dispatchEvent(
              new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
            );
        });
      };
      try {
        await act(async () => root.render(createElement(ChatPane, props)));
        expect(host.querySelector('.weq-message-repeat')).not.toBeNull();
        await openMenu();
        expect(menuButton()?.disabled).toBe(false);
        await act(async () => menuButton()!.click());
        expect(onRepeatMessage).toHaveBeenCalledWith(history, conversation);
        expect(host.querySelector('.message-context-menu')).toBeNull();
        await openMenu();
        expect(menuButton()?.disabled).toBe(true);
        expect(host.querySelector<HTMLButtonElement>('.weq-message-repeat')?.disabled).toBe(true);
        await act(async () => finish());
        await act(async () =>
          host.querySelector<HTMLButtonElement>('.weq-message-repeat')!.click(),
        );
        expect(onRepeatMessage).toHaveBeenLastCalledWith(latest, conversation);
        await act(async () => finish());
        expect(onDraftChange).not.toHaveBeenCalled();
        expect(onDraftClear).not.toHaveBeenCalled();
        await act(async () =>
          root.render(createElement(ChatPane, { ...props, deletedIds: new Set(['history']) })),
        );
        await openMenu();
        expect(menuButton()).toBeUndefined();
      } finally {
        await act(async () => {
          finish();
          root.unmount();
        });
        host.remove();
      }
    },
  );
});
