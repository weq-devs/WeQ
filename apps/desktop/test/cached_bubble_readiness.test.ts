import { act, createElement, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { MessageBubbleSkin } from '@weq/service';
import { useMsgDecoration } from '../src/renderer/src/hooks/useMsgDecoration';
import { seedMessageBubbles } from '../src/renderer/src/lib/messageBubbles';
import { syncDressSkin } from '../src/renderer/src/hooks/useDressSkin';
import { applyDressSkin } from '../src/renderer/src/lib/dressSkin';

const query = vi.hoisted(() => vi.fn((_ids: unknown, _options: unknown) => ({ data: undefined })));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { dressup: { resolveMsgDecoration: { useQuery: query } } } },
}));
vi.mock('../src/renderer/src/components/QqMessageContent', async () => {
  const { createContext } = await import('react');
  return { MsgDecorationEnabledContext: createContext({ bubble: true, font: true, widget: true }) };
});
afterEach(() => {
  applyDressSkin(null, null, null);
  query.mockClear();
  vi.unstubAllGlobals();
});

it('本地覆盖气泡同样复用提前携带的静态底图', () => {
  const skin: MessageBubbleSkin = {
    itemId: 21995,
    slice: { left: 4, right: 4, top: 4, bottom: 4 },
    imageSize: { w: 40, h: 40 },
    textColor: '#516196',
    localFile: 'synthetic.png',
    baseImage: 'data:image/png;base64,c3ludGhldGlj',
  };
  seedMessageBubbles([skin]);
  syncDressSkin({
    bubbles: [skin],
    fonts: [],
    widgets: [],
    activeBubble: skin.itemId,
    activeFont: 0,
    activeWidget: 0,
    scope: 'mine',
    background: 'none',
    backgroundFile: '',
    widgetId: '',
    backgroundOpacity: 1,
  });
  expect(document.getElementById('weq-dress-skin')?.textContent).toContain(skin.baseImage);
});

it.each(['inline', 'prefetch', 'missing', 'inline-failed-predecode'] as const)(
  '首次提交就显示消息，不等待查询、可见性回调或解码：%s',
  async (source) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const decode = vi.fn(() =>
      source === 'inline-failed-predecode'
        ? Promise.reject(new Error('预解码预算不足'))
        : new Promise<void>(() => {}),
    );
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        naturalWidth = 40;
        naturalHeight = 40;
        removeAttribute() {
          this.src = '';
        }
        decode = decode;
      },
    );
    // 可见性通知始终不回调，覆盖虚拟列表预挂载阶段。
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const skin: MessageBubbleSkin = {
      itemId:
        source === 'inline'
          ? 21991
          : source === 'prefetch'
            ? 21992
            : source === 'missing'
              ? 21993
              : 21994,
      slice: { left: 4, right: 4, top: 4, bottom: 4 },
      imageSize: { w: 40, h: 40 },
      textColor: '#516196',
      localFile: 'synthetic.png',
      baseImage: 'data:image/png;base64,c3ludGhldGlj',
    };
    if (source === 'prefetch') seedMessageBubbles([skin]);
    const host = document.createElement('div');
    const root = createRoot(host);
    const commits: number[] = [];
    function Message() {
      const ref = useRef<HTMLDivElement | null>(null);
      const result = useMsgDecoration(
        {
          bubbleId: skin.itemId,
          fontId: 31991,
          widgetId: 0,
          cachedBubble: source.startsWith('inline') ? skin : undefined,
        },
        source === 'inline-failed-predecode' ? undefined : ref,
      );
      useLayoutEffect(() => {
        commits.push(result.bubbleId);
      });
      return createElement(
        'div',
        { ref, className: 'message-line', 'data-bubble': result.bubbleId },
        createElement('div', { className: 'message-content' }, '正文立即显示'),
      );
    }
    try {
      act(() => root.render(createElement(Message)));
      expect(host.textContent).toBe('正文立即显示');
      expect(commits[0]).toBe(source === 'missing' ? 0 : skin.itemId);
      expect(host.querySelector('[data-bubble-pending]')).toBeNull();
      expect((host.querySelector('.message-content') as HTMLElement).style.visibility).toBe('');
      if (source !== 'missing') {
        expect(
          document.head.querySelector(`[data-weq-msg-decoration="bubble:${skin.itemId}:base"]`)
            ?.textContent,
        ).toContain(skin.baseImage);
        expect(
          query.mock.calls.some(
            (args) =>
              (args[0] as { bubbleId: number }).bubbleId === skin.itemId &&
              (args[1] as { enabled: boolean }).enabled,
          ),
        ).toBe(false);
      }
      await act(async () => {});
      expect(host.textContent).toBe('正文立即显示');
      expect(commits.every((id) => id === (source === 'missing' ? 0 : skin.itemId))).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
