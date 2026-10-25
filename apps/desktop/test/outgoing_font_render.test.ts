import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageBubble } from '../src/renderer/src/im-template/template/messageBubble';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { MsgDecorationEnabledContext } from '../src/renderer/src/components/QqMessageContent';
import { composerSendError } from '../src/renderer/src/im-template/template/composerSend';

const fixture = vi.hoisted(() => ({
  ids: [] as number[],
  fontActive: false,
  bubbleActive: false,
  widgetActive: false,
  scope: 'all',
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? (input?: { fontId?: number; bubbleId?: number; widgetId?: number }) => {
              if (path.at(-1) === 'resolveMsgDecoration') {
                const id = input?.fontId ?? 0;
                fixture.ids.push(id);
                return {
                  data: {
                    font: id ? { itemId: id, deriveVersion: 1, fx: null } : null,
                    bubble: input?.bubbleId
                      ? {
                          itemId: input.bubbleId,
                          slice: [4, 4, 4, 4],
                          imageSize: [40, 40],
                          textColor: 'var(--foreground)',
                        }
                      : null,
                    widget: input?.widgetId
                      ? {
                          itemId: input.widgetId,
                          animated: false,
                          url: 'https://example.test/widget.png',
                        }
                      : null,
                  },
                };
              }
              return { data: undefined };
            }
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn() })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/hooks/useSelfPendant', () => ({
  useSelfPendant: () => 'https://example.test/self-widget.png',
  useSelfBubble: () => 2116371,
}));
vi.mock('../src/renderer/src/hooks/useActiveWidget', () => ({
  useActiveWidget: () => ({
    widget: fixture.widgetActive
      ? { animated: false, itemId: 10002, url: 'https://example.test/local-widget.png' }
      : null,
    scope: fixture.scope,
    fontActive: fixture.fontActive,
    bubbleActive: fixture.bubbleActive,
  }),
  useActiveFontFx: () => null,
}));
afterEach(() => vi.unstubAllGlobals());

it('发送气泡按请求字体显示，读回可换款或清除，本地使用字体仍可覆盖', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let enabled = { bubble: true, font: true, widget: true };
  const render = (fontId: number, sending: boolean, mine = true, bubbleId: number | null = 21001) =>
    act(async () =>
      root.render(
        createElement(
          MsgDecorationEnabledContext.Provider,
          { value: enabled },
          createElement(MessageBubble, {
            message: {
              id: 'font-row',
              conversationId: demo.conversations[0]!.id,
              senderId: demo.user.id,
              body: '实际字体',
              createdAt: new Date(0).toISOString(),
              qqElements: [{ type: 'text', data: { textContent: '实际字体' } }],
              ...(bubbleId === null ? {} : { decoration: { bubbleId, widgetId: 10001, fontId } }),
              ...(sending ? { optimistic: 'sending' as const } : {}),
            },
            conversation: demo.conversations[0]!,
            sender: demo.user,
            mine,
            senderName: '我',
            senderAvatarUrl: null,
            senderSeed: 'me',
            showSenderName: false,
            active: true,
            onContextMenu: vi.fn(),
            onLongPress: vi.fn(),
            renderers: [{ id: 'test', match: () => true, render: () => '实际字体' }],
          }),
        ),
      ),
    );
  try {
    await render(0, true, true, null);
    expect(host.querySelector('.message-line')?.getAttribute('data-bubble')).toBe('2116371');
    await render(0, false, true, null);
    expect(host.querySelector('.message-line')?.hasAttribute('data-bubble')).toBe(false);
    for (const [id, sending] of [
      [31001, true],
      [32002, false],
      [0, false],
    ] as const) {
      await render(id, sending);
      expect(host.querySelector('.message-line')?.getAttribute('data-font')).toBe(
        id ? String(id) : null,
      );
      if (id) expect(document.head.textContent).toContain(`weq-message-dress-${id}`);
    }
    expect(fixture.ids).toContain(31001);
    expect(fixture.ids).toContain(32002);
    expect(host.querySelector('.message-line')?.getAttribute('data-bubble')).toBe('21001');
    expect(host.querySelector('.weq-avatar-pendant-img')).not.toBeNull();
    await render(32002, false, true, 0);
    expect(host.querySelector('.message-line')?.hasAttribute('data-bubble')).toBe(false);
    fixture.widgetActive = true;
    await render(31001, true);
    expect(host.querySelector('.weq-avatar-pendant-img')?.getAttribute('src')).toBe(
      'https://example.test/local-widget.png',
    );
    enabled = { bubble: false, font: true, widget: false };
    await render(31001, true);
    expect(host.querySelector('.message-line')?.hasAttribute('data-bubble')).toBe(false);
    expect(host.querySelector('.message-line')?.getAttribute('data-font')).toBe('31001');
    expect(host.querySelector('.weq-avatar-pendant-img')).toBeNull();
    await render(31001, true, true, null);
    expect(host.querySelector('.weq-avatar-pendant-img')).toBeNull();
    fixture.widgetActive = false;
    enabled = { bubble: true, font: false, widget: true };
    await render(31001, false, false);
    expect(host.querySelector('.message-line')?.getAttribute('data-bubble')).toBe('21001');
    expect(host.querySelector('.message-line')?.hasAttribute('data-font')).toBe(false);
    enabled = { bubble: true, font: true, widget: true };
    fixture.bubbleActive = true;
    await render(31001, false);
    expect(host.querySelector('.message-line')?.hasAttribute('data-bubble')).toBe(false);
    fixture.bubbleActive = false;
    fixture.fontActive = true;
    await render(31001, false);
    expect(host.querySelector('.message-line')?.hasAttribute('data-font')).toBe(false);
    expect(host.querySelector('.message-line')?.hasAttribute('data-fontfx')).toBe(false);
    await render(32002, false, false);
    expect(host.querySelector('.message-line')?.hasAttribute('data-font')).toBe(false);
    fixture.scope = 'mine';
    await render(32002, false, false);
    expect(host.querySelector('.message-line')?.getAttribute('data-font')).toBe('32002');
    fixture.fontActive = false;
    fixture.bubbleActive = false;
    await render(31001, false);
    expect(host.querySelector('.message-line')?.getAttribute('data-font')).toBe('31001');
  } finally {
    fixture.fontActive = false;
    fixture.bubbleActive = false;
    fixture.widgetActive = false;
    fixture.scope = 'all';
    await act(async () => root.unmount());
    host.remove();
  }
});

it('主进程旧接口缺失时提示重启，不伪装成已发送或静默降级', () => {
  expect(
    composerSendError(new Error('No "query"-procedure on path "account.prepareChatFont"')),
  ).toContain('本条消息尚未发送');
  expect(composerSendError(new Error('网络断开'))).toBe('网络断开');
  expect(
    composerSendError(new Error('No "query"-procedure on path "account.prepareChatDecoration"')),
  ).toContain('本条消息尚未发送');
});
