import { PAGE_SIZE, prefetchTarget, REFRESH_CAP } from './paging';
import { toMessageWire } from './messageProjection';
import type { MessageWire, ChatMsgWire, PendingScrollRestore } from './types';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IS_WEB } from '../../lib/target.shared';
import { dataSaverActive, useDataSaver } from '../../lib/dataSaver';
import { createCoalescedRefresh } from '../../lib/coalescedRefresh';
import { timelineViewport } from '../../lib/timelineViewport';
import {
  installMessagePerformanceProbe,
  measureMessagePhase,
  recordMessageCounter,
  recordMessagePhase,
} from '../../lib/messagePerformance';
import { client } from '../../trpc/client';
import { ConversationWindowCache, conversationWindowKey } from '../../lib/conversationWindowCache';
import { ConversationFirstPage } from '../../lib/conversationFirstPage';
import type { MessageReadWindow } from '../../../../shared/message_read';
import { mergeRefreshedWindow } from '../../lib/conversationRefresh';
import { readCachedMessageWindow } from '../../lib/cachedMessageRead';
import { rememberRecentMessageCache } from '../../lib/recentMessageCache';
import { useQueryClient } from '@tanstack/react-query';
import {
  captureReadingPosition,
  type ConversationReadingPosition,
} from '../../lib/conversationReadingPosition';
import type { Conversation } from '../../im-template/template';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';

type WindowStateInput = {
  messageScope: string;
  binding: QQWriteBinding | null;
  messageActivity: { enabled: boolean; revision: number };
  setVisibleConversationIds: React.Dispatch<React.SetStateAction<readonly string[]>>;
};

/** 消息窗口状态、缓存、预取及实时校准共用一个生命周期。 */
export function useMessageWindowState({
  messageScope,
  binding,
  messageActivity,
  setVisibleConversationIds,
}: WindowStateInput) {
  const queryCache = useQueryClient();
  const messageScopeRef = useRef(messageScope);
  messageScopeRef.current = messageScope;
  const messageBindingRef = useRef(binding);
  messageBindingRef.current = binding;
  const conversationWindows = useMemo(() => new ConversationWindowCache<MessageWire>(), []);
  const dbRevisionRef = useRef(0),
    loadedRevisionRef = useRef(0),
    windowVerifiedAtRef = useRef(0);
  const verifiedWindowRowsRef = useRef<MessageWire[] | null>(null);
  const cachedScrollRef = useRef<{ id: string; position: ConversationReadingPosition } | null>(
    null,
  );
  const [initialReadingPosition, setInitialReadingPosition] =
    useState<ConversationReadingPosition>();
  const [loadingNewerMessages, setLoadingNewerMessages] = useState(false);
  const [readFailure, setReadFailure] = useState<{
    key: string;
    stage: 'entry' | 'older' | 'newer';
  } | null>(null);
  const entryLoadingRef = useRef(false);
  const visitedHistoryRef = useRef(false);
  useEffect(() => {
    const binding = messageBindingRef.current;
    messageScopeRef.current = binding
      ? JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId])
      : '';
    return () => {
      messageScopeRef.current = '';
      conversationWindows.clear();
    };
  }, [conversationWindows]);

  // Seq-window message model: a single ASC (oldest→newest) list for the open
  // conversation, plus whether it still reaches the latest message and whether
  // older history remains. `loaded[0].msgSeq` is the window's lower cursor.
  const [loadedWindow, setLoadedWindow] = useState<{ key: string; rows: MessageWire[] }>({
    key: '',
    rows: [],
  });
  const loaded = loadedWindow.rows;

  const nativeMessageScrollRef = useRef<HTMLDivElement | null>(null);
  const captureNativeTimeline = useCallback((element: HTMLDivElement | null) => {
    nativeMessageScrollRef.current = element;
  }, []);
  const pendingMessageCommit = useRef<number | null>(null);
  useEffect(() => installMessagePerformanceProbe(), [messageScope]);
  useLayoutEffect(() => {
    const intent = entryScrollIntentRef.current;
    if (intent?.revision === null) {
      const scroll = nativeMessageScrollRef.current;
      intent.revision = scroll ? timelineViewport(scroll)?.scrollRevision?.() : undefined;
    }
    if (pendingMessageCommit.current === null) return;
    recordMessagePhase('stateToCommit', performance.now() - pendingMessageCommit.current);
    pendingMessageCommit.current = null;
    const committed = performance.now();
    const frame = requestAnimationFrame(() =>
      recordMessagePhase('commitToFrame', performance.now() - committed),
    );
    return () => cancelAnimationFrame(frame);
  }, [loaded]);
  const [anchoredToLatest, setAnchoredToLatest] = useState(true);

  // Latest active-conversation identity, read by the once-mounted live
  // subscription (which must not re-subscribe on every selection change).
  const selectionRef = useRef<{
    id: string;
    kind: 'direct' | 'group';
    readWindow: MessageReadWindow;
  } | null>(null);
  const setLoaded = useCallback((update: React.SetStateAction<MessageWire[]>) => {
    const scope = messageScopeRef.current;
    const selection = selectionRef.current;
    if (!scope || !selection) return;
    const key = conversationWindowKey(
      scope,
      selection.kind === 'group' ? 'group' : 'c2c',
      selection.id,
    );
    setLoadedWindow((current) => {
      // 低优先级更新可能在切会话后才重放，提交时仍须核对正文所属窗口。
      if (current.key !== key) return current;
      const rows = typeof update === 'function' ? update(current.rows) : update;
      return rows === current.rows ? current : { key, rows };
    });
  }, []);
  const entryScrollIntentRef = useRef<{
    selection: object | null;
    revision: number | undefined | null;
  } | null>(null);
  const [messageReadOwner] = useState(() => crypto.randomUUID());
  const firstPages = useMemo(() => {
    const binding = messageBindingRef.current;
    return new ConversationFirstPage<MessageWire>({
      owner: crypto.randomUUID(),
      valid: () =>
        Boolean(
          messageScope && messageScopeRef.current === messageScope && messageBindingRef.current,
        ),
      version: () => conversationWindows.revision,
      changedSince: (target, version) =>
        conversationWindows.changedSince(
          conversationWindowKey(messageScope, target.kind, target.conv),
          version,
        ),
      canPrefetch: (target) =>
        (!IS_WEB || !dataSaverActive() || useDataSaver.getState().behavior.dataSaverPrefetch) &&
        conversationWindows.canPrefetch(
          conversationWindowKey(messageScope, target.kind, target.conv),
        ),
      fresh: (target) => {
        const key = conversationWindowKey(messageScope, target.kind, target.conv);
        const cached = conversationWindows.peek(key);
        return Boolean(
          cached &&
            !cached.dirty &&
            !conversationWindows.changedSince(key, cached.revision) &&
            Date.now() - cached.verifiedAt < 3000,
        );
      },
      subscribe: (target, readWindow, prefetch, stage, error) => {
        recordMessageCounter(prefetch ? 'prefetchStarted' : 'entryCold');
        const subscription = client.account.latestPage.subscribe(
          { ...binding, ...target, readWindow, prefetch },
          {
            onData: (value) =>
              stage({
                complete: value.complete,
                reuseLocal: value.reuseLocal,
                rows: value.rows.map(toMessageWire),
              }),
            onError: error,
            onComplete: () => error(new Error('首屏读取结束但缺少完整结果')),
          },
        );
        return () => subscription.unsubscribe();
      },
      promote: (readWindow) => {
        recordMessageCounter('prefetchAdopted');
        void client.account.promoteMessageRead.mutate({ ...binding, readWindow }).catch(() => {});
      },
      cancel: (readWindow) => {
        void client.account.cancelMessageRead.mutate({ ...binding, readWindow }).catch(() => {});
      },
      store: (target, rows, prefetch, revision) => {
        if (prefetch) recordMessageCounter('prefetchReady');
        conversationWindows.put(conversationWindowKey(messageScope, target.kind, target.conv), {
          rows: [...rows].reverse(),
          anchored: true,
          hasOlder: rows.length >= target.limit,
          hasNewer: false,
          revision,
          dirty: false,
          storedAt: Date.now(),
          verifiedAt: Date.now(),
          prefetched: prefetch,
        });
      },
    });
  }, [messageScope, conversationWindows]);
  useEffect(() => () => firstPages.dispose(), [firstPages]);
  const prefetchVisible = useCallback(
    (rows: readonly Conversation[]) => {
      const ids = rows.map((row) => row.id);
      setVisibleConversationIds((previous) =>
        previous.length === ids.length && previous.every((id, index) => id === ids[index])
          ? previous
          : ids,
      );
      firstPages.setVisible(
        rows.flatMap((row) => {
          const target = prefetchTarget(row);
          return target ? [target] : [];
        }),
      );
    },
    [firstPages, setVisibleConversationIds],
  );
  const prefetchIntent = useCallback(
    (row: Conversation) => {
      const target = prefetchTarget(row);
      if (target) firstPages.hint(target);
    },
    [firstPages],
  );
  const messageReadGeneration = useRef(0);
  const attemptedReplyMedia = useMemo(() => new WeakSet<MessageWire>(), [messageScope]);
  const replyMediaRows = useMemo(() => new WeakMap<MessageWire, MessageWire>(), [messageScope]);
  const [replyMediaRevision, setReplyMediaRevision] = useState(0);
  // Current loaded-window descriptor, read by the once-mounted subscription.
  const windowRef = useRef<{ minSeq: string | null; anchored: boolean }>({
    minSeq: null,
    anchored: true,
  });

  // Live refresh of the open conversation: re-read seq >= minSeq and replace the
  // window. Only when anchored to latest — a history/search window (not yet
  // wired) must NOT be dragged up to the latest. Stable identity → the
  // subscription below mounts once.
  const refreshWindow = useMemo(() => {
    const request = createCoalescedRefresh(async (): Promise<void> => {
      const scope = messageScopeRef.current,
        binding = messageBindingRef.current;
      const revision = conversationWindows.revision;
      if (!scope || !binding || entryLoadingRef.current || document.visibilityState === 'hidden')
        return;
      const sel = selectionRef.current;
      const win = windowRef.current;
      if (!sel || !win.anchored) return;
      const kind = sel.kind === 'group' ? 'group' : 'c2c';
      const conv = sel.id;
      const key = conversationWindowKey(scope, kind, conv);
      const previous = loadedRef.current;
      recordMessageCounter('windowStarted');
      try {
        const rows = await measureMessagePhase('windowQuery', async () => {
          if (win.minSeq !== null) {
            const cached = await readCachedMessageWindow(
              {
                ...binding,
                kind,
                conv,
                sinceSeq: win.minSeq,
                limit: REFRESH_CAP,
                readWindow: sel.readWindow,
              },
              previous,
            );
            if (cached !== undefined) return cached;
          }
          const page =
            win.minSeq === null
              ? await client.account.listLatest.query({
                  ...binding,
                  kind,
                  conv,
                  limit: PAGE_SIZE,
                  readWindow: sel.readWindow,
                  deferReplyMedia: true,
                })
              : await client.account.listFrom.query({
                  kind,
                  conv,
                  sinceSeq: win.minSeq,
                  limit: REFRESH_CAP,
                  ...binding,
                  readWindow: sel.readWindow,
                  deferReplyMedia: true,
                });
          return mergeRefreshedWindow(
            previous,
            page.map(toMessageWire).reverse(),
            win.minSeq === null ? PAGE_SIZE : REFRESH_CAP,
          );
        });
        // Reject results after a conversation switch or a history-window change,
        // including switching away and back to the same conversation.
        if (
          revision < loadedRevisionRef.current ||
          messageScopeRef.current !== scope ||
          selectionRef.current !== sel ||
          windowRef.current !== win ||
          !windowRef.current.anchored
        ) {
          recordMessageCounter('windowDiscarded');
          return;
        }
        if (loadedRef.current !== previous) {
          // 读期间收到漫游记录：重新比较新窗口，不用旧前缀覆盖它。
          void request();
          return;
        }
        setReadFailure((failure) =>
          failure?.key === key && failure.stage === 'entry' ? null : failure,
        );
        loadedRevisionRef.current = revision;
        windowVerifiedAtRef.current = Date.now();
        const scroll = nativeMessageScrollRef.current;
        if (
          rows !== loadedRef.current &&
          scroll &&
          scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 48
        ) {
          cachedScrollRef.current = {
            id: conv,
            position: captureReadingPosition(scroll, { transient: true }),
          };
        }
        verifiedWindowRowsRef.current = rows;
        if (rows !== loadedRef.current) {
          pendingMessageCommit.current = performance.now();
          rememberRecentMessageCache(queryCache, scope, kind, conv, rows, hasOlderRef.current);
        }
        setLoaded(rows);
      } catch (err) {
        console.error('[live] refreshWindow failed', err);
      }
    });
    return request;
  }, [conversationWindows, setLoaded, queryCache]);

  useEffect(() => {
    if (messageActivity.enabled && messageActivity.revision > 0) void refreshWindow();
  }, [messageActivity.enabled, messageActivity.revision, refreshWindow]);

  const [hasOlder, setHasOlder] = useState(true);
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  // True only in a "jump context" window (anchored=false) that has newer
  // messages below it; drives scroll-down paging via `requestNewerMessages`.
  const [hasNewer, setHasNewer] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [trackedConversationId, setTrackedConversationId] = useState<string | null>(null);
  const [trackedMessageScope, setTrackedMessageScope] = useState(messageScope);

  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);

  // Mirror of `loaded` for the reply-jump handler (a stable callback that must
  // read the current window without being re-created on every message change).
  const loadedRef = useRef<MessageWire[]>([]);
  const pendingScrollRestoreRef = useRef<PendingScrollRestore | null>(null);

  const pendingSearchJumpRef = useRef<{
    conv: string;
    kind: 'group' | 'c2c';
    seq: string;
    record?: ChatMsgWire;
    messageId?: string;
  } | null>(null);

  return {
    messageScope,
    messageScopeRef,
    messageBindingRef,
    conversationWindows,
    dbRevisionRef,
    loadedRevisionRef,
    windowVerifiedAtRef,
    verifiedWindowRowsRef,
    cachedScrollRef,
    initialReadingPosition,
    setInitialReadingPosition,
    loadingNewerMessages,
    setLoadingNewerMessages,
    readFailure,
    setReadFailure,
    entryLoadingRef,
    visitedHistoryRef,
    loadedWindow,
    setLoadedWindow,
    loaded,
    nativeMessageScrollRef,
    captureNativeTimeline,
    pendingMessageCommit,
    anchoredToLatest,
    setAnchoredToLatest,
    selectionRef,
    setLoaded,
    entryScrollIntentRef,
    messageReadOwner,
    firstPages,
    prefetchVisible,
    prefetchIntent,
    messageReadGeneration,
    attemptedReplyMedia,
    replyMediaRows,
    replyMediaRevision,
    setReplyMediaRevision,
    windowRef,
    refreshWindow,
    hasOlder,
    setHasOlder,
    hasNewer,
    setHasNewer,
    messagesLoading,
    setMessagesLoading,
    trackedConversationId,
    setTrackedConversationId,
    trackedMessageScope,
    setTrackedMessageScope,
    loadingOlderRef,
    loadingNewerRef,
    loadedRef,
    pendingScrollRestoreRef,
    pendingSearchJumpRef,
  };
}
export type MessageWindowState = ReturnType<typeof useMessageWindowState>;
