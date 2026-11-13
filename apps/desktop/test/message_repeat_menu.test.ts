import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { MessageContextMenu } from '../src/renderer/src/im-template/template/messageContextMenu';
import { createTemplateDemoData } from './support/templateDemoData';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { MessageRow } from '../src/renderer/src/im-template/template/messageRow';
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
  it('桌面触屏长按保留实际命中元素，不能丢失媒体或卡片目标', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'direct')!;
    const hold = vi.fn();
    try {
      await act(async () =>
        root.render(
          createElement(MessageRow, {
            user: demo.user,
            conversation,
            message: {
              ...base,
              body: '长按正文',
              qqElements: [{ type: 'text', data: { textContent: '长按正文' } }],
            },
            onLongPress: hold,
          }),
        ),
      );
      const target =
        host.querySelector('.message-content span') ?? host.querySelector('.message-content')!;
      act(() =>
        target.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            pointerType: 'touch',
            button: 0,
            clientX: 100,
            clientY: 100,
          }),
        ),
      );
      act(() => vi.advanceTimersByTime(500));
      expect(hold).toHaveBeenCalledOnce();
      expect(hold.mock.calls[0]?.[2]).toBe(target);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  });
  it('多选追加保留原选区，右键转发仍只处理当前消息', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'direct')!;
    const rows = ['one', 'two'].map((id) => ({
      ...base,
      id,
      conversationId: conversation.id,
      body: id,
      qqElements: [{ type: 'text', data: { textContent: id } }],
    }));
    const forward = vi.fn();
    const menuAction = (label: string) =>
      host.querySelector<HTMLButtonElement>(`.message-context-menu [aria-label="${label}"]`)!;
    const open = async (id: string) =>
      act(async () =>
        host
          .querySelector(`[data-message-id="${id}"] .message-bubble`)!
          .dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
          ),
      );
    try {
      await act(async () =>
        root.render(
          createElement(ChatPane, {
            user: demo.user,
            conversation,
            messages: rows,
            draft: '',
            onDraftChange: vi.fn(),
            onDraftClear: vi.fn(),
            onSend: vi.fn(),
            onBack: vi.fn(),
            onForwardMessages: forward,
          }),
        ),
      );
      for (const id of ['one', 'two']) {
        await open(id);
        await act(async () => menuAction('多选').click());
      }
      expect(host.querySelector('.selection-bar-info')?.getAttribute('aria-label')).toBe(
        '已选 2 条消息',
      );
      await open('two');
      await act(async () => menuAction('转发').click());
      expect(forward).toHaveBeenCalledWith([rows[1]], conversation);
      expect(host.querySelector('.selection-bar-info')?.getAttribute('aria-label')).toBe(
        '已选 2 条消息',
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([{ recall: {} }, { deletedKind: 'weq' }, { source: 'roaming' as const }])(
    '保留消息 %j 可沿真实消息菜单入口重发',
    async (flags) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('localStorage', new Storage());
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const demo = createTemplateDemoData();
      const conversation = demo.conversations.find((item) => item.type === 'direct')!;
      const row = {
        ...base,
        ...flags,
        id: 'retained',
        conversationId: conversation.id,
        body: '保留正文',
        qqElements: [{ type: 'text', data: { textContent: '保留正文' } }],
      } as Message;
      const repeat = vi.fn(async () => {});
      try {
        await act(async () =>
          root.render(
            createElement(ChatPane, {
              user: demo.user,
              conversation,
              messages: [row],
              draft: '',
              onDraftChange: vi.fn(),
              onDraftClear: vi.fn(),
              onSend: vi.fn(),
              onBack: vi.fn(),
              onRepeatMessage: repeat,
              sendAvailable: true,
            }),
          ),
        );
        await act(async () =>
          host
            .querySelector('[data-message-id="retained"] .message-bubble')!
            .dispatchEvent(
              new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
            ),
        );
        await act(async () =>
          host.querySelector<HTMLButtonElement>('.message-context-menu [aria-label="+1"]')!.click(),
        );
        expect(repeat).toHaveBeenCalledWith(row, conversation);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it('点击重发右键选中的原消息，离线、发送期间或不可发送消息保留格位并禁用', async () => {
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
      return [...host.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === '+1',
      );
    }
    try {
      const button = await render();
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(onRepeat).toHaveBeenCalledOnce();
      expect(onRepeat).toHaveBeenCalledWith(normal);
      for (const reason of ['QQ 未在线', '正在发送消息，请稍候']) {
        const disabled = await render(normal, reason);
        expect(disabled?.getAttribute('aria-disabled')).toBe('true');
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
          (button) => button.getAttribute('aria-label') === '+1',
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
        const repeat = host.querySelector('.weq-message-repeat');
        expect(repeat).not.toBeNull();
        expect(repeat?.parentElement?.classList.contains('weq-repeat-content')).toBe(true);
        expect(repeat?.parentElement?.querySelector('.message-content')).not.toBeNull();
        expect(repeat?.parentElement?.querySelector('.weq-message-heading')).toBeNull();
        await openMenu();
        expect(menuButton()?.disabled).toBe(false);
        await act(async () => menuButton()!.click());
        expect(onRepeatMessage).toHaveBeenCalledWith(history, conversation);
        expect(host.querySelector('.message-context-menu')).toBeNull();
        await openMenu();
        expect(menuButton()?.getAttribute('aria-disabled')).toBe('true');
        expect(host.querySelector<HTMLButtonElement>('.weq-message-repeat')?.disabled).toBe(true);
        await act(async () => finish());
        await act(async () =>
          host.querySelector<HTMLButtonElement>('.weq-message-repeat')!.click(),
        );
        expect(onRepeatMessage).toHaveBeenLastCalledWith(latest, conversation);
        await act(async () => finish());
        expect(onDraftChange).not.toHaveBeenCalled();
        expect(onDraftClear).not.toHaveBeenCalled();
        for (const deleted of ['previous', 'latest']) {
          await act(async () =>
            root.render(createElement(ChatPane, { ...props, deletedIds: new Set([deleted]) })),
          );
          expect(host.querySelector('.weq-message-repeat')).toBeNull();
        }
        await act(async () =>
          root.render(createElement(ChatPane, { ...props, deletedIds: new Set(['history']) })),
        );
        await openMenu();
        expect(menuButton()?.disabled).toBe(false);
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
