import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '../im-template/template/types';
import {
  reviewMessageBatch,
  type MessageBatchAction,
  type MessageReviewContext,
} from '../lib/messageBatchAction';

type Review = {
  scope: unknown;
  action: MessageBatchAction;
  batch: ReturnType<typeof reviewMessageBatch>;
  resolve: (messages: Message[] | null) => void;
};

export function useMessageBatchReview(scope: unknown) {
  const [review, setReview] = useState<Review | null>(null);
  const pending = useRef<Review | null>(null);
  const finish = useCallback((messages: Message[] | null) => {
    const current = pending.current;
    pending.current = null;
    setReview(null);
    current?.resolve(messages);
  }, []);
  useLayoutEffect(() => {
    setReview((current) => (current?.scope === scope ? current : null));
    return () => {
      pending.current?.resolve(null);
      pending.current = null;
    };
  }, [scope]);
  const ask = useCallback(
    (action: MessageBatchAction, messages: Message[], context?: MessageReviewContext) => {
      if (pending.current || !messages.length) return Promise.resolve(null);
      const batch = reviewMessageBatch(messages, action, context);
      if (!batch.groups.length) return Promise.resolve(messages);
      return new Promise<Message[] | null>((resolve) => {
        const next = { scope, action, batch, resolve };
        pending.current = next;
        setReview(next);
      });
    },
    [scope],
  );
  return { review: review?.scope === scope ? review : null, ask, finish };
}
