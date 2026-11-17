import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageBubble } from '../src/renderer/src/im-template/template/messageBubble';
import { createTemplateDemoData } from './support/templateDemoData';
import { MsgDecorationEnabledContext } from '../src/renderer/src/components/QqMessageContent';
import { composerSendError } from '../src/renderer/src/im-template/template/composerSend';
import { stubReadyDecorationResources } from './support/readyDecorationResources';

const fixture = vi.hoisted(() => ({
  ids: [] as number[],
  fontActive: false,
  bubbleActive: false,
  widgetActive: false,
  scope: 'all',
  unresolved: false,
  remote: false,
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return fixture.remote;
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const resolved = new Map<string, object>();
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? (input?: { fontId?: number; bubbleId?: number; widgetId?: number }) => {
              if (path.at(-1) === 'resolveMsgDecoration') {
                if (fixture.unresolved) return { data: undefined };
                const id = input?.fontId ?? 0;
                fixture.ids.push(id);
                const key = JSON.stringify(input);
                if (!resolved.has(key)) {
                  resolved.set(key, {
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
                  });
                }
                return { data: resolved.get(key) };
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

it('装扮请求悬挂不隐藏正文；远程传输圈含电脑图标，宿主回执后切回普通圈，失败保留标签', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  fixture.unresolved = true;
  fixture.remote = true;
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (outgoingToHost: boolean, optimistic: 'sending' | 'failed' = 'sending') =>
    act(async () =>
      root.render(
        createElement(MessageBubble, {
          message: {
            id: 'local',
            conversationId: demo.conversations[0]!.id,
            senderId: demo.user.id,
            body: '不等电脑和装扮',
            createdAt: new Date().toISOString(),
            optimistic,
            outgoingToHost,
            decoration: { bubbleId: 21001, fontId: 32002, widgetId: 10001 },
          },
          conversation: demo.conversations[0]!,
          sender: demo.user,
          mine: true,
          senderName: '我',
          onContextMenu: vi.fn(),
          onLongPress: vi.fn(),
          renderers: [{ id: 'local', match: () => true, render: () => '不等电脑和装扮' }],
        }),
      ),
    );
  try {
    await render(true);
    expect(host.textContent).toContain('不等电脑和装扮');
    expect(host.querySelector('[aria-label="正在传给电脑"] .lucide-monitor')).not.toBeNull();
    await render(false);
    expect(host.querySelector('[aria-label="发送中"]')).not.toBeNull();
    expect(host.querySelector('.lucide-monitor')).toBeNull();
    await render(true, 'failed');
    expect(host.textContent).toContain('发送失败');
    expect(host.querySelector('.weq-message-sending')).toBeNull();
    fixture.remote = false;
    await render(true);
    expect(host.querySelector('[aria-label="发送中"]')).not.toBeNull();
    expect(host.querySelector('.lucide-monitor')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    fixture.remote = false;
    fixture.unresolved = false;
  }
});

it('排队、立即发送与失败重试使用不同语义图标，发送回调保持不变', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  const demo = createTemplateDemoData();
  const send = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (optimistic: 'queued' | 'failed') =>
    act(async () =>
      root.render(
        createElement(MessageBubble, {
          message: {
            id: 'icon-state',
            conversationId: demo.conversations[0]!.id,
            senderId: demo.user.id,
            body: '合成消息',
            createdAt: new Date(0).toISOString(),
            optimistic,
          },
          conversation: demo.conversations[0]!,
          sender: demo.user,
          mine: true,
          senderName: '我',
          senderAvatarUrl: null,
          senderSeed: 'me',
          showSenderName: false,
          active: true,
          onContextMenu: vi.fn(),
          onLongPress: vi.fn(),
          onStartOutgoing: send,
          renderers: [{ id: 'icon-test', match: () => true, render: () => '合成消息' }],
        }),
      ),
    );
  try {
    await render('queued');
    const queued = host.querySelector<HTMLButtonElement>('[aria-label="立即发送"]')!;
    expect(queued.querySelector('.lucide-clock')).not.toBeNull();
    await act(async () => queued.focus());
    expect(queued.querySelector('.lucide-send-horizontal')).not.toBeNull();
    await act(async () => queued.click());
    expect(send).toHaveBeenCalledOnce();
    await render('failed');
    const failed = host.querySelector<HTMLButtonElement>('[aria-label="重试发送"]')!;
    expect(failed.querySelector('.lucide-refresh-cw')).not.toBeNull();
    await act(async () => failed.click());
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('发送气泡按请求字体显示，读回可换款或清除，本地使用字体仍可覆盖', async () => {
  stubReadyDecorationResources();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let enabled = { bubble: true, font: true, widget: true };
  const render = (
    fontId: number,
    sending: boolean,
    mine = true,
    bubbleId: number | null = 21001,
    widgetId = 10001,
  ) =>
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
              ...(bubbleId === null ? {} : { decoration: { bubbleId, widgetId, fontId } }),
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

    fixture.scope = 'fallback';
    fixture.bubbleActive = fixture.widgetActive = true;
    for (const mine of [true, false]) {
      await render(32002, false, mine);
      expect(host.querySelector('.message-line')?.getAttribute('data-font')).toBe('32002');
      expect(host.querySelector('.message-line')?.getAttribute('data-bubble')).toBe('21001');
      expect(host.querySelector('.weq-avatar-pendant-img')?.getAttribute('src')).toBe(
        'https://example.test/widget.png',
      );
      fixture.unresolved = true;
      await render(32002, false, mine);
      const line = host.querySelector('.message-line')!;
      expect(line.getAttribute('data-record-bubble')).toBe('21001');
      expect(line.getAttribute('data-record-font')).toBe('32002');
      expect(line.hasAttribute('data-record-widget')).toBe(true);
      expect(line.hasAttribute('data-bubble')).toBe(false);
      expect(line.hasAttribute('data-font')).toBe(false);
      expect(host.querySelector('[src="https://example.test/local-widget.png"]')).toBeNull();
      fixture.unresolved = false;
    }
    await render(32002, false, false, 0, 0);
    expect(host.querySelector('.message-line')?.hasAttribute('data-record-bubble')).toBe(false);
    expect(host.querySelector('.message-line')?.getAttribute('data-font')).toBe('32002');
    expect(host.querySelector('.weq-avatar-pendant-img')?.getAttribute('src')).toBe(
      'https://example.test/local-widget.png',
    );
    await render(0, false, true, 0, 0);
    expect(host.querySelector('[src="https://example.test/local-widget.png"]')).toBeNull();
    expect(host.querySelector('.message-line')?.hasAttribute('data-record-widget')).toBe(true);
    fixture.scope = 'mine';
    fixture.fontActive = false;
    fixture.bubbleActive = false;
    await render(31001, false);
    expect(host.querySelector('.message-line')?.getAttribute('data-font')).toBe('31001');
  } finally {
    fixture.fontActive = false;
    fixture.bubbleActive = false;
    fixture.widgetActive = false;
    fixture.scope = 'all';
    fixture.unresolved = false;
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
