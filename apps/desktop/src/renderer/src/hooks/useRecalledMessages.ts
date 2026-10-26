import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Conversation } from '../im-template/template/types';
import { useAppLock } from '../state/lock';

type Origin = 'conversation' | 'settings';
interface RecallRequest<Row> {
  source: string;
  conversation: Conversation;
  origin: Origin;
  rows: Row[];
  loading: boolean;
  error: string | null;
}

/** 共用撤回读取链路；宿主来源、关闭/重开及锁屏均使旧请求失效，不声称取消底层 I/O。 */
export function useRecalledMessages<Row>(
  source: string,
  liveSource: Readonly<RefObject<string>>,
  load: (conversation: Conversation) => Promise<Row[]>,
) {
  const locked = useAppLock((state) => state.locked);
  const mounted = useRef(true);
  const bindingRef = useRef({ source, locked });
  if (bindingRef.current.source !== source || bindingRef.current.locked !== locked)
    bindingRef.current = { source, locked };
  const binding = bindingRef.current;
  const current = useRef<RecallRequest<Row> | null>(null);
  const emptyRows = useRef<Row[]>([]);
  const [request, setRequest] = useState<RecallRequest<Row> | null>(null);
  if (request && (request.source !== source || locked)) {
    current.current = null;
    setRequest(null);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current = null;
    };
  }, []);

  const close = useCallback(
    (origin?: Origin) => {
      if (!mounted.current || bindingRef.current !== binding || liveSource.current !== source)
        return;
      if (origin && current.current?.origin !== origin) return;
      current.current = null;
      setRequest(null);
    },
    [source, binding, liveSource],
  );

  const open = useCallback(
    async (conversation: Conversation, origin: Origin = 'conversation') => {
      const isCurrentSource = () =>
        mounted.current &&
        bindingRef.current === binding &&
        liveSource.current === source &&
        !useAppLock.getState().locked;
      if (!isCurrentSource()) return;
      const next: RecallRequest<Row> = {
        source,
        conversation,
        origin,
        rows: [],
        loading: true,
        error: null,
      };
      current.current = next;
      setRequest(next);
      const stillCurrent = () => isCurrentSource() && current.current === next;
      try {
        const rows = await load(conversation);
        if (!stillCurrent()) return;
        const completed = { ...next, rows, loading: false };
        current.current = completed;
        setRequest(completed);
      } catch (error) {
        if (!stillCurrent()) return;
        const failed = {
          ...next,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        };
        current.current = failed;
        setRequest(failed);
      }
    },
    [source, binding, liveSource, load],
  );

  const retry = useCallback(() => {
    const previous = current.current;
    if (previous) return open(previous.conversation, previous.origin);
  }, [open]);
  const visible =
    !locked && request?.source === source && liveSource.current === source ? request : null;
  return {
    conversation: visible?.conversation ?? null,
    origin: visible?.origin ?? null,
    rows: visible?.rows ?? emptyRows.current,
    loading: visible?.loading ?? false,
    error: visible?.error ?? null,
    open,
    close,
    retry,
  };
}
