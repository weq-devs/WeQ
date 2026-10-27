import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetEmojiItem } from '@weq/codec';
import { useToast } from '../components/Toast';

export const REACTION_SYNC_TIMEOUT_MS = 15_000;

export interface PendingReactionFeedback {
  code: string;
  isSet: boolean;
  snapshot?: SetEmojiItem[];
}

interface ReactionTask extends PendingReactionFeedback {
  scope: string;
  messageId: string;
  snapshot: SetEmojiItem[];
}

/** 写入回执不等于本地消息已刷新；加载反馈覆盖两者之间的同步空档。 */
export function useReactionFeedback(
  scope: string,
  messages: readonly { id: string; setEmojiList?: SetEmojiItem[] }[],
) {
  const [state, setState] = useState<{ task: ReactionTask; acknowledged: boolean } | null>(null);
  const active = useRef<ReactionTask | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const clear = useCallback((task: ReactionTask) => {
    if (active.current !== task) return;
    active.current = null;
    setState(null);
  }, []);
  useEffect(() => {
    active.current = null;
    setState(null);
    return () => {
      active.current = null;
    };
  }, [scope]);

  const begin = useCallback(
    (messageId: string, code: string, isSet: boolean, snapshot: SetEmojiItem[] = []) => {
      const task: ReactionTask = {
        scope: currentScope.current,
        messageId,
        code,
        isSet,
        snapshot: snapshot.map((item) => ({ ...item })),
      };
      active.current = task;
      setState({ task, acknowledged: false });
      return {
        acknowledge: () => {
          if (active.current === task && currentScope.current === task.scope)
            setState({ task, acknowledged: true });
        },
        cancel: () => clear(task),
      };
    },
    [clear],
  );

  const pending = state?.task.scope === scope ? state.task : null;
  useEffect(() => {
    if (!pending || !state?.acknowledged) return;
    const message = messages.find((row) => row.id === pending.messageId);
    if (!message) return;
    const item = message.setEmojiList?.find((row) => row.emojiId === pending.code);
    const previous = pending.snapshot.find((row) => row.emojiId === pending.code);
    // 多人贴过的表情突然整枚缺失，不能直接当作“已撤回自己”的读回结果。
    const confirmed = pending.isSet
      ? Boolean(item?.isSelfSet)
      : !item?.isSelfSet && (Boolean(item) || (previous?.setNum ?? 0) <= 1);
    if (confirmed) clear(pending);
  }, [pending, state?.acknowledged, messages, clear]);

  useEffect(() => {
    if (!pending || !state?.acknowledged) return;
    const timer = setTimeout(() => {
      if (active.current !== pending || currentScope.current !== pending.scope) return;
      clear(pending);
      useToast.getState().push({
        tone: 'warning',
        title: '表情回应同步较慢',
        detail: '请求已提交，但尚未读回更新后的消息，请稍后查看，无需重复操作。',
      });
    }, REACTION_SYNC_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending, state?.acknowledged, clear]);

  return { pending, begin };
}
