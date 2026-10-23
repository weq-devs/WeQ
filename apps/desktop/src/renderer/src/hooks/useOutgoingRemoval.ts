import { useCallback, useEffect, useRef } from 'react';
import type { OutgoingRemoval } from '../lib/localOutgoing';

/**
 * 应用一次「本机发送占位移除」（失败占位 / 未送达占位），并在下一个微任务里
 * 刷新会话列表与当前窗口。
 *
 * `remove` 由调用方用纯函数算好（`failedOutgoingRemoval` / `rejectedOutgoingRemoval`），
 * 传 null 表示这条不该被清理 —— 此时什么都不做，也不触发刷新。
 */
export function useOutgoingRemoval(
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
  return useCallback((remove: OutgoingRemoval | null, convId: string): boolean => {
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
