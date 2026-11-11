import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageRow } from '../src/renderer/src/im-template/template/messageRow';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { installTouchContextMenu } from '../src/renderer/src/lib/touchContextMenu';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useQuery') return () => ({ data: undefined, isLoading: false });
        if (key === 'useInfiniteQuery')
          return () => ({ data: { pages: [{ items: [] }] }, isLoading: false });
        return proxy();
      },
    });
  return { trpc: proxy(), client: proxy() };
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let stop: (() => void) | undefined;
const context = vi.fn();
const longPress = vi.fn();
const change = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'group')!;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      h(MessageRow, {
        user: demo.user,
        conversation,
        message: {
          ...demo.messages[0]!,
          conversationId: conversation.id,
          msgSeq: '42',
          setEmojiList: [{ emojiId: '76', setNum: 1, isSelfSet: false }],
        },
        onContextMenu: context,
        onLongPress: longPress,
        onReactionChange: change,
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  stop?.();
  stop = undefined;
  host.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function pointer(target: Element, type: string, pointerType = 'touch') {
  act(() =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    ),
  );
}

const chip = () => host.querySelector<HTMLElement>('.msg-reaction')!;
const panel = () => document.querySelector<HTMLElement>('.reaction-likers');
function contextMenu(target: Element) {
  act(() =>
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
}

it.each([false, true])('触屏长按贴表情只显示回应人，不打开消息菜单（Web 长按=%s）', (web) => {
  if (web) stop = installTouchContextMenu(document);
  const target = chip().querySelector('img, span')!;
  pointer(target, 'pointerover');
  pointer(target, 'pointerdown');
  act(() => vi.advanceTimersByTime(500));
  expect(panel()).not.toBeNull();
  expect(document.querySelectorAll('.reaction-likers')).toHaveLength(1);
  expect(longPress).not.toHaveBeenCalled();
  contextMenu(target);
  expect(context).not.toHaveBeenCalled();
  pointer(target, 'pointerup');
  expect(change).not.toHaveBeenCalled();
});

it('回应人 portal 内长按不穿透到原消息菜单', () => {
  stop = installTouchContextMenu(document);
  pointer(chip(), 'pointerover', 'mouse');
  act(() => vi.advanceTimersByTime(180));
  const target = panel()!.querySelector('.reaction-likers-state-text')!;
  pointer(target, 'pointerdown');
  act(() => vi.advanceTimersByTime(500));
  pointer(target, 'pointerup');
  expect(panel()).not.toBeNull();
  expect(context).not.toHaveBeenCalled();
  expect(longPress).not.toHaveBeenCalled();
});

it('短按贴表情仍可跟贴，鼠标悬停仍显示回应人名单', () => {
  pointer(chip(), 'pointerdown');
  pointer(chip(), 'pointerup');
  act(() => chip().click());
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ msgSeq: '42' }), '76', true);
  pointer(chip(), 'pointerover', 'mouse');
  act(() => vi.advanceTimersByTime(180));
  expect(panel()).not.toBeNull();
  expect(context).not.toHaveBeenCalled();
  expect(longPress).not.toHaveBeenCalled();
});

it('消息正文长按和鼠标右键仍打开原消息菜单', () => {
  const bubble = host.querySelector('.message-bubble')!;
  pointer(bubble, 'pointerdown');
  act(() => vi.advanceTimersByTime(500));
  pointer(bubble, 'pointerup');
  expect(longPress).toHaveBeenCalledOnce();
  contextMenu(bubble);
  expect(context).toHaveBeenCalledOnce();
  expect(panel()).toBeNull();
});
