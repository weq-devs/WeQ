import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Conversation } from '../im-template/template/types';
import { useAppLock } from '../state/lock';

type Origin = 'conversation' | 'settings';
export interface RecordPage<Row, Cursor> {
  rows: Row[];
  nextBefore: Cursor | null;
}
interface RecordRequest<Row, Cursor> extends RecordPage<Row, Cursor> {
  owner: object;
  source: string;
  conversation: Conversation;
  origin: Origin;
  loading: boolean;
  error: string | null;
  excluded: ((row: Row) => boolean)[];
}

/** 来源切换、关闭/重开及锁屏均使旧请求失效，不声称取消底层 I/O。 */
export function useConversationMessageRecords<Row, Cursor>(
  source: string,
  liveSource: Readonly<RefObject<string>>,
  load: (conversation: Conversation, before?: Cursor) => Promise<RecordPage<Row, Cursor>>,
  loadMedia?: (
    conversation: Conversation,
    rows: Row[],
  ) => Promise<((rows: Row[]) => Row[]) | undefined>,
) {
  const locked = useAppLock((state) => state.locked);
  const mounted = useRef(true);
  const bindingRef = useRef({ source, locked });
  if (bindingRef.current.source !== source || bindingRef.current.locked !== locked)
    bindingRef.current = { source, locked };
  const binding = bindingRef.current;
  const current = useRef<RecordRequest<Row, Cursor> | null>(null);
  const emptyRows = useRef<Row[]>([]);
  const [request, setRequest] = useState<RecordRequest<Row, Cursor> | null>(null);
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

  const isCurrentSource = useCallback(
    () =>
      mounted.current &&
      bindingRef.current === binding &&
      liveSource.current === source &&
      !useAppLock.getState().locked,
    [binding, liveSource, source],
  );
  const requestPage = useCallback(
    async (next: RecordRequest<Row, Cursor>, before?: Cursor) => {
      if (!isCurrentSource()) return;
      current.current = next;
      setRequest(next);
      const active = () => {
        const state = current.current;
        return isCurrentSource() && state?.owner === next.owner ? state : null;
      };
      let page: RecordPage<Row, Cursor>;
      try {
        page = await load(next.conversation, before);
      } catch (error) {
        const state = active();
        if (!state) return;
        const failed = {
          ...state,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        };
        current.current = failed;
        setRequest(failed);
        return;
      }
      const state = active();
      if (!state) return;
      const loaded = page.rows.filter((row) => !state.excluded.some((match) => match(row)));
      current.current = {
        ...state,
        rows: [...state.rows, ...loaded],
        nextBefore: page.nextBefore,
        loading: false,
      };
      setRequest(current.current);
      if (!loaded.length || !loadMedia) return;
      void loadMedia(next.conversation, loaded)
        .then((patch) => {
          const live = active();
          if (!patch || !live) return;
          const rows = patch(live.rows);
          if (rows === live.rows) return;
          current.current = { ...live, rows };
          setRequest(current.current);
        })
        .catch(() => {
          // 正文已显示；引用媒体读不到时保留原占位。
        });
    },
    [isCurrentSource, load, loadMedia],
  );

  const open = useCallback(
    (conversation: Conversation, origin: Origin = 'conversation') =>
      requestPage({
        owner: {},
        source,
        conversation,
        origin,
        rows: [],
        nextBefore: null,
        loading: true,
        error: null,
        excluded: [],
      }),
    [requestPage, source],
  );
  const continueReading = useCallback(
    (retry: boolean) => {
      if (!isCurrentSource()) return;
      const state = current.current;
      if (
        !state ||
        state.loading ||
        (retry ? !state.error : state.error || state.nextBefore === null)
      )
        return;
      return requestPage({ ...state, loading: true, error: null }, state.nextBefore ?? undefined);
    },
    [isCurrentSource, requestPage],
  );
  const retry = useCallback(() => continueReading(true), [continueReading]);
  const loadMore = useCallback(() => continueReading(false), [continueReading]);
  const removeRows = useCallback(
    (conversationId: string, match: (row: Row) => boolean) => {
      if (!isCurrentSource()) return;
      const state = current.current;
      if (state?.conversation.id !== conversationId) return;
      current.current = {
        ...state,
        rows: state.rows.filter((row) => !match(row)),
        excluded: [...state.excluded, match],
      };
      setRequest(current.current);
    },
    [isCurrentSource],
  );
  const visible =
    !locked && request?.source === source && liveSource.current === source ? request : null;
  return {
    conversation: visible?.conversation ?? null,
    origin: visible?.origin ?? null,
    rows: visible?.rows ?? emptyRows.current,
    loading: visible?.loading ?? false,
    hasMore: visible?.nextBefore != null,
    error: visible?.error ?? null,
    open,
    close,
    retry,
    loadMore,
    removeRows,
  };
}
