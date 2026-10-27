import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useReactionFeedback,
  REACTION_SYNC_TIMEOUT_MS,
} from '../src/renderer/src/hooks/useReactionFeedback';
import { SetEmojiReactions } from '../src/renderer/src/components/SetEmojiReactions';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: { getState: () => ({ push: warn }) },
}));
vi.mock('../src/renderer/src/components/FaceEmoji', () => ({
  FaceEmoji: () => createElement('span', { className: 'face-emoji' }),
}));

const before = [{ emojiId: '14', setNum: 2, isSelfSet: true }];
let feedback: ReturnType<typeof useReactionFeedback>;
const cleanups: Array<() => void> = [];

function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe({ scope, list }: { scope: string; list?: typeof before }) {
    feedback = useReactionFeedback(scope, [{ id: 'm1', setEmojiList: list }]);
    return createElement(SetEmojiReactions, {
      list,
      groupId: '12345',
      sequence: 42,
      interaction: {
        onChange: () => {},
        busy: Boolean(feedback.pending),
        pending: feedback.pending ?? undefined,
      },
    });
  }
  const render = (list: typeof before | undefined = before, scope = 'account:group') => {
    act(() => root.render(createElement(Probe, { scope, list })));
  };
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return render;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('贴表情等待消息读回', () => {
  it('发送结束后保持加载，数秒后读回自己的新回应才结束', () => {
    const render = fixture();
    let task: ReturnType<typeof feedback.begin>;
    act(() => {
      task = feedback.begin('m1', '76', true, before);
    });
    act(() => task.acknowledge());
    act(() => vi.advanceTimersByTime(3000));
    render([]);
    expect(feedback.pending?.code).toBe('76');
    expect(document.querySelectorAll('.msg-reaction')).toHaveLength(2);
    expect(document.querySelector('[aria-busy="true"]')?.getAttribute('aria-label')).toBe(
      '正在贴表情 76',
    );
    render([...before, { emojiId: '76', setNum: 1, isSelfSet: true }]);
    expect(feedback.pending).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    act(() => vi.advanceTimersByTime(REACTION_SYNC_TIMEOUT_MS));
    expect(warn).not.toHaveBeenCalled();
  });

  it('撤回多人回应时，临时空列表不算确认，读回剩余回应才结束', () => {
    const render = fixture();
    let task: ReturnType<typeof feedback.begin>;
    act(() => {
      task = feedback.begin('m1', '14', false, before);
    });
    render([]);
    act(() => task.acknowledge());
    expect(feedback.pending?.snapshot).toEqual(before);
    expect(document.querySelector('[aria-busy="true"]')?.getAttribute('aria-label')).toBe(
      '正在撤回表情回应 14',
    );
    render([{ emojiId: '14', setNum: 1, isSelfSet: false }]);
    expect(feedback.pending).toBeNull();
  });

  it('只有自己贴过时，撤回后空列表是有效结果；读回早于回执也能接上', () => {
    const render = fixture();
    let task: ReturnType<typeof feedback.begin>;
    act(() => {
      task = feedback.begin('m1', '14', false, [{ ...before[0]!, setNum: 1 }]);
    });
    render([]);
    expect(feedback.pending).not.toBeNull();
    act(() => task.acknowledge());
    expect(feedback.pending).toBeNull();
  });

  it('失败立即清除；同步超时单独提示，不谎称发送失败', () => {
    fixture();
    let task: ReturnType<typeof feedback.begin>;
    act(() => {
      task = feedback.begin('m1', '76', true, before);
    });
    act(() => task.cancel());
    expect(feedback.pending).toBeNull();
    act(() => {
      task = feedback.begin('m1', '76', true, before);
    });
    act(() => task.acknowledge());
    act(() => vi.advanceTimersByTime(REACTION_SYNC_TIMEOUT_MS));
    expect(feedback.pending).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ title: '表情回应同步较慢' }));
  });

  it('切换账号或会话后旧回调不影响新操作', () => {
    const render = fixture();
    let old: ReturnType<typeof feedback.begin>;
    act(() => {
      old = feedback.begin('m1', '76', true, before);
    });
    render(before, 'other:group');
    expect(feedback.pending).toBeNull();
    act(() => {
      feedback.begin('m1', '99', true, before);
    });
    act(() => {
      old.acknowledge();
      old.cancel();
    });
    expect(feedback.pending?.code).toBe('99');
  });
});
