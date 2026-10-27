import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SetEmojiReactions } from '../src/renderer/src/components/SetEmojiReactions';

vi.mock('../src/renderer/src/components/FaceEmoji', () => ({ FaceEmoji: () => null }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getSelfProfile: { useQuery: () => ({ data: { uin: '10001' } }) },
      messageReactionUsers: {
        useInfiniteQuery: () => ({ data: { pages: [{ items: [] }] }, hasNextPage: false }),
      },
    },
  },
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(self: boolean, blockedReason?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  act(() =>
    root.render(
      createElement(SetEmojiReactions, {
        list: [
          { emojiId: '14', setNum: 2, isSelfSet: self },
          { emojiId: '76', setNum: 1, isSelfSet: false },
        ],
        groupId: '10001',
        sequence: 42,
        interaction: { onChange, blockedReason },
      }),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const buttons = host.querySelectorAll<HTMLButtonElement>('.msg-reaction');
  act(() => buttons[0]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
  act(() => vi.advanceTimersByTime(180));
  expect(document.querySelector('.reaction-likers')).not.toBeNull();
  return { buttons, onChange };
}

function clickWithPointer(target: HTMLElement) {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  act(() => target.click());
}

it.each([false, true])('悬停打开真实名单后，仍可点击表情跟贴或撤回（自己已贴=%s）', (self) => {
  const { buttons, onChange } = fixture(self);
  clickWithPointer(buttons[0]!.querySelector<HTMLElement>('.msg-reaction-count-value')!);
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenCalledWith('14', !self);
  expect(document.querySelector('.reaction-likers')).toBeNull();
});

it('名单打开时点击同条消息的其他表情也能直接跟贴', () => {
  const { buttons, onChange } = fixture(false);
  clickWithPointer(buttons[1]!);
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenCalledWith('76', true);
});

it('受限时点击原表情不发送，也不关闭已有名单', () => {
  const { buttons, onChange } = fixture(false, 'QQ 未在线');
  clickWithPointer(buttons[0]!);
  expect(onChange).not.toHaveBeenCalled();
  expect(document.querySelector('.reaction-likers')).not.toBeNull();
});

it('点击无关按钮仍只关闭名单，不穿透执行按钮动作', () => {
  const { onChange } = fixture(false);
  const outside = document.createElement('button');
  const action = vi.fn();
  outside.addEventListener('click', action);
  document.body.append(outside);
  cleanups.push(() => outside.remove());
  clickWithPointer(outside);
  expect(document.querySelector('.reaction-likers')).toBeNull();
  expect(action).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
});
