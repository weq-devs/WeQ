import { useCallback, useEffect, useRef } from 'react';
import type { Message } from '../im-template/template/types';
import { failedOutgoingRemoval, type OutgoingRemoval } from '../lib/localOutgoing';

export function useFailedOutgoingRemoval(
  apply: (remove: OutgoingRemoval) => void,
  refresh: (conversations: ReadonlySet<string>) => Promise<unknown>,
) {
  const latest = useRef({ apply, refresh });
  latest.current = { apply, refresh };
  const queued = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queued.current.clear();
    };
  }, []);
  return useCallback((message: Message, convId: string) => {
    const remove = failedOutgoingRemoval(message, convId);
    if (!mounted.current || !remove) return false;
    latest.current.apply(remove);
    const scheduled = queued.current.size > 0;
    queued.current.add(convId);
    if (!scheduled)
      queueMicrotask(() => {
        const conversations = new Set(queued.current);
        queued.current.clear();
        if (!mounted.current || !conversations.size) return;
        // 移除已生效，附带读取失败不回滚本机清理，更不重发消息。
        void Promise.resolve()
          .then(() => (mounted.current ? latest.current.refresh(conversations) : undefined))
          .catch(() => {});
      });
    return true;
  }, []);
}
