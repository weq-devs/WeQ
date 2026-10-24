import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SetEmojiReactions } from '../src/renderer/src/components/SetEmojiReactions';

vi.mock('../src/renderer/src/components/FaceEmoji', () => ({ FaceEmoji: () => null }));
vi.mock('../src/renderer/src/components/ReactionLikersPanel', () => ({
  ReactionLikersPanel: () => createElement('div', { 'data-testid': 'likers' }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('点击已有回应可跟贴或撤回，悬停仍可查看名单，忙碌与受限状态不发送', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const render = (self = false, busy = false, blockedReason: string | null = null, sequence = 42) =>
    act(() =>
      root.render(
        createElement(SetEmojiReactions, {
          list: [{ emojiId: '14', setNum: 2, isSelfSet: self }],
          groupId: '10001',
          sequence,
          interaction: { onChange, busy, blockedReason },
        }),
      ),
    );
  const button = () => host.querySelector('button')!;
  try {
    render();
    act(() => button().click());
    expect(onChange).toHaveBeenLastCalledWith('14', true);
    render(true);
    act(() => button().click());
    expect(onChange).toHaveBeenLastCalledWith('14', false);
    render(false, true);
    act(() => button().click());
    render(true, true);
    act(() => button().click());
    render(false, false, 'QQ 未在线');
    act(() => button().click());
    expect(button().title).toBe('QQ 未在线');
    act(() => vi.advanceTimersByTime(180));
    expect(host.querySelector('[data-testid="likers"]')).not.toBeNull();
    render(false, false, null, 0);
    act(() => button().click());
    expect(onChange).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
