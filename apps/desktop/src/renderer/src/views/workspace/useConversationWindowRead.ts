import { PAGE_SIZE, GROUP_INITIAL_PAGE_SIZE } from './paging';
import { toMessageWire } from './messageProjection';
import type { MessageWire, ChatMsgWire } from './types';
import { useCallback, useEffect, useLayoutEffect } from 'react';
import { IS_WEB } from '../../lib/target';
import { unreadRequestBatches, type UnreadRequest } from '../../lib/unreadRequests';
import { timelineViewport } from '../../lib/timelineViewport';
import {
  measureMessagePhase,
  recordMessageCounter,
  recordMessagePhase,
} from '../../lib/messagePerformance';
import { mergeRoamingTimeline, timelineRowKey } from '../../../../shared/roaming_timeline';
import { useWebConnection } from '../../state/webConnection';
import { client } from '../../trpc/client';
import { unreadChatType } from '@weq/codec';
import {
  conversationWindowKey,
  restorableConversationWindow,
} from '../../lib/conversationWindowCache';
import { isConversationPagingVisible } from '../../lib/conversationPaging';
import { loadConversationEntry } from '../../lib/conversationEntry';
import { mergeRefreshedWindow } from '../../lib/conversationRefresh';
import {
  captureReadingPosition,
  restoreReadingPosition,
} from '../../lib/conversationReadingPosition';
import { useConversationRecoveryPosition } from '../../hooks/useConversationRecoveryPosition';
import type { Conversation } from '../../im-template/template';
import type { MessageWindowState } from './useMessageWindowState';

type SelectionInput = { selectedUid: string | null; isDirect: boolean; isGroup: boolean };
type WindowSelectionInput = SelectionInput & {
  activeConversationId: string | null;
  selectedMessageWindowKey: string;
  messagesTabActive: boolean;
  readFromFirstUnread: boolean;
  onScopeChange: () => void;
};
type EntryInput = SelectionInput & {
  selectedConversation: Conversation | null | undefined;
  messagesTabActive: boolean;
  loadingInitialMessages: boolean;
  readFromFirstUnread: boolean;
  messageCount: number;
  centerWindowOnSeq: (
    conv: string,
    kind: 'group' | 'c2c',
    seq: string,
    record?: ChatMsgWire,
    messageId?: string,
  ) => Promise<boolean>;
};

export async function readUnreadInfos(input: UnreadRequest) {
  const batches = unreadRequestBatches(input, IS_WEB);
  return (
    await Promise.all(batches.map((batch) => client.account.getUnreadInfos.query(batch)))
  ).flat();
}

/** 渲染期间先切换窗口身份，不能把旧会话正文提交到新会话。 */
export function useConversationWindowSelection(
  state: MessageWindowState,
  {
    activeConversationId,
    selectedUid,
    isDirect,
    isGroup,
    selectedMessageWindowKey,
    messagesTabActive,
    readFromFirstUnread,
    onScopeChange,
  }: WindowSelectionInput,
) {
  const {
    messageScope,
    conversationWindows,
    dbRevisionRef,
    loadedRevisionRef,
    windowVerifiedAtRef,
    verifiedWindowRowsRef,
    cachedScrollRef,
    setInitialReadingPosition,
    setLoadingNewerMessages,
    entryLoadingRef,
    loadedWindow,
    setLoadedWindow,
    loaded,
    nativeMessageScrollRef,
    anchoredToLatest,
    setAnchoredToLatest,
    selectionRef,
    windowRef,
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
  } = state;
  // Reset paging *synchronously* when the open conversation changes. Doing this
  // during render (instead of in an effect) means React discards this render
  // before committing, so we never paint a frame where the previous chat's
  // messages are shown under the new conversation, nor flash an empty
  // "还没有消息" before the new query result is folded in.
  if (trackedConversationId !== activeConversationId || trackedMessageScope !== messageScope) {
    const old = selectionRef.current;
    if (
      trackedMessageScope &&
      trackedMessageScope === messageScope &&
      old?.id === trackedConversationId &&
      loadedWindow.key ===
        conversationWindowKey(messageScope, old.kind === 'group' ? 'group' : 'c2c', old.id) &&
      (!messagesLoading || loaded.length > 0)
    ) {
      const scroll = nativeMessageScrollRef.current;
      const position = scroll ? captureReadingPosition(scroll) : undefined;
      const anchorIndex = loaded.findIndex((row) => timelineRowKey(row) === position?.anchorId);
      if (position && anchorIndex >= 0) {
        const anchor = loaded[anchorIndex]!;
        if (old.kind === 'group' || anchor.source !== 'roaming' || anchor.ntSeqVerified)
          position.anchorSeq = anchor.msgSeq;
      }
      conversationWindows.put(
        conversationWindowKey(messageScope, old.kind === 'group' ? 'group' : 'c2c', old.id),
        {
          rows: loaded,
          anchored: anchoredToLatest,
          hasOlder,
          hasNewer,
          scrollTop: scroll?.scrollTop ?? 0,
          readingPosition: position,
          revision: loadedRevisionRef.current,
          dirty:
            loadedRevisionRef.current !== dbRevisionRef.current ||
            verifiedWindowRowsRef.current !== loaded,
          storedAt: Date.now(),
          verifiedAt: windowVerifiedAtRef.current,
        },
        anchorIndex >= 0 ? anchorIndex : undefined,
      );
    }
    if (trackedMessageScope !== messageScope) {
      conversationWindows.clear();
      dbRevisionRef.current = 0;
      loadedRevisionRef.current = 0;
      windowVerifiedAtRef.current = 0;
      selectionRef.current = null;
      windowRef.current = { minSeq: null, anchored: true };
      if (trackedMessageScope) {
        pendingSearchJumpRef.current = null;
        onScopeChange();
      }
    }
    const cached =
      messageScope &&
      selectedUid &&
      (isDirect || isGroup) &&
      pendingSearchJumpRef.current?.conv !== selectedUid
        ? conversationWindows.get(
            conversationWindowKey(messageScope, isGroup ? 'group' : 'c2c', selectedUid),
          )
        : undefined;
    const restored = restorableConversationWindow(cached, readFromFirstUnread ?? false);
    // 新窗口提交前就拒收旧读取；不能等 passive effect 换 selection，
    // 否则这段间隙收到的旧首屏／实时刷新仍能覆盖新会话。
    selectionRef.current = null;
    windowRef.current = {
      minSeq: restored?.rows[0]?.msgSeq ?? null,
      anchored: restored?.anchored ?? true,
    };
    setTrackedMessageScope(messageScope);
    setTrackedConversationId(activeConversationId);
    setLoadedWindow({
      key: selectedMessageWindowKey,
      rows: restored?.rows ?? [],
    });
    loadedRef.current = restored?.rows ?? [];
    verifiedWindowRowsRef.current = restored?.rows ?? null;
    setAnchoredToLatest(restored?.anchored ?? true);
    setHasOlder(restored?.hasOlder ?? true);
    setHasNewer(restored?.hasNewer ?? false);
    setMessagesLoading(Boolean(activeConversationId) && !restored);
    setLoadingNewerMessages(false);
    entryLoadingRef.current = false;
    loadedRevisionRef.current = restored?.revision ?? 0;
    windowVerifiedAtRef.current = restored?.verifiedAt ?? 0;
    setInitialReadingPosition(
      readFromFirstUnread
        ? (restored?.readingPosition ?? (restored ? { scrollTop: restored.scrollTop } : undefined))
        : undefined,
    );
    cachedScrollRef.current = null;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    pendingScrollRestoreRef.current = null;
  } else if (loadedWindow.key !== selectedMessageWindowKey) {
    // 并发重放可能带回旧状态，恢复当前窗口，不能把它缓存或提交到新会话。
    setLoadedWindow({
      key: selectedMessageWindowKey,
      rows: loadedRef.current,
    });
  }

  useLayoutEffect(() => {
    const restore = cachedScrollRef.current;
    if (!restore || restore.id !== selectedUid || !messagesTabActive) return;
    const scroll = nativeMessageScrollRef.current;
    if (scroll) {
      restoreReadingPosition(scroll, restore.position);
      cachedScrollRef.current = null;
    }
  }, [selectedUid, loaded, messagesTabActive, cachedScrollRef, nativeMessageScrollRef]);
}

export function useMessageReadSelection(
  state: MessageWindowState,
  { selectedUid, isDirect, isGroup }: SelectionInput,
) {
  const {
    messageScope,
    messageBindingRef,
    selectionRef,
    entryScrollIntentRef,
    messageReadOwner,
    messageReadGeneration,
  } = state;
  // Keep the live-subscription's view of "what's open" current without
  // re-subscribing on every selection change.
  useEffect(() => {
    const binding = messageBindingRef.current;
    const readWindow = { owner: messageReadOwner, generation: ++messageReadGeneration.current };
    entryScrollIntentRef.current = null;
    selectionRef.current =
      selectedUid && (isDirect || isGroup)
        ? { id: selectedUid, kind: isGroup ? 'group' : 'direct', readWindow }
        : null;
    // 换会话就清空群内成员搜索，否则新群的成员列表会顶着上一个群的关键字。

    return () => {
      if (binding && selectedUid && (isDirect || isGroup))
        void client.account.cancelMessageRead.mutate({ ...binding, readWindow }).catch(() => {});
    };
  }, [
    selectedUid,
    isDirect,
    isGroup,
    messageScope,
    messageReadOwner,
    messageBindingRef,
    messageReadGeneration,
    entryScrollIntentRef,
    selectionRef,
  ]);
}

export function useMessageWindowDescriptor(state: MessageWindowState) {
  const { loaded, anchoredToLatest, windowRef, loadedRef } = state;
  // Keep the loaded-window descriptor in sync for the once-mounted subscription.
  useEffect(() => {
    const minSeq = loaded[0]?.msgSeq ?? null;
    if (windowRef.current.minSeq !== minSeq || windowRef.current.anchored !== anchoredToLatest)
      windowRef.current = { minSeq, anchored: anchoredToLatest };
    loadedRef.current = loaded;
  }, [loaded, anchoredToLatest, windowRef, loadedRef]);
}

/** 首屏、缓存校准和双向分页保留各自的失效条件。 */
export function useConversationWindowEntry(
  state: MessageWindowState,
  {
    selectedConversation,
    selectedUid,
    isDirect,
    isGroup,
    messagesTabActive,
    loadingInitialMessages,
    readFromFirstUnread,
    messageCount,
    centerWindowOnSeq,
  }: EntryInput,
) {
  const {
    messageScope,
    messageScopeRef,
    messageBindingRef,
    conversationWindows,
    dbRevisionRef,
    loadedRevisionRef,
    windowVerifiedAtRef,
    verifiedWindowRowsRef,
    cachedScrollRef,
    setInitialReadingPosition,
    setLoadingNewerMessages,
    entryLoadingRef,
    loaded,
    nativeMessageScrollRef,
    pendingMessageCommit,
    setAnchoredToLatest,
    selectionRef,
    setLoaded,
    entryScrollIntentRef,
    firstPages,
    windowRef,
    refreshWindow,
    hasOlder,
    setHasOlder,
    hasNewer,
    setHasNewer,
    messagesLoading,
    setMessagesLoading,
    loadingOlderRef,
    loadingNewerRef,
    loadedRef,
    pendingScrollRestoreRef,
    pendingSearchJumpRef,
  } = state;
  // 命中缓存先恢复窗口，随后按水位增量读取；有变更或较久未校准时才重读已有范围。
  const entryChatType =
    selectedConversation?.type === 'direct'
      ? (unreadChatType(selectedConversation.chatType ?? 1) ?? 1)
      : 2;
  const { read: readRecoveryPosition, applied: recoveryPositionApplied } =
    useConversationRecoveryPosition({
      conv: selectedUid,
      kind: isGroup ? 'group' : 'c2c',
      rows: loaded,
      enabled: messagesTabActive && !loadingInitialMessages && Boolean(messageScope),
    });
  useEffect(() => {
    const binding = messageBindingRef.current,
      scope = messageScope;
    if (!selectedUid || !(isDirect || isGroup) || !scope || !binding) {
      setMessagesLoading(false);
      return undefined;
    }
    const kind = isGroup ? 'group' : 'c2c';
    const conv = selectedUid;
    let cancelled = false;
    const selection = selectionRef.current,
      revision = dbRevisionRef.current;
    let expectedWindow = windowRef.current;
    const limit = isGroup ? GROUP_INITIAL_PAGE_SIZE : PAGE_SIZE;
    const active = () =>
      !cancelled && messageScopeRef.current === scope && selectionRef.current === selection;
    const valid = () => active() && windowRef.current === expectedWindow;
    const jump = pendingSearchJumpRef.current;
    if (jump && jump.conv === conv) {
      pendingSearchJumpRef.current = null;
      void centerWindowOnSeq(jump.conv, jump.kind, jump.seq, jump.record, jump.messageId).finally(
        () => {
          if (!cancelled && messageScopeRef.current === scope) setMessagesLoading(false);
        },
      );
      return () => {
        cancelled = true;
      };
    }
    const candidate = conversationWindows.get(conversationWindowKey(scope, kind, conv));
    const cached = restorableConversationWindow(candidate, readFromFirstUnread ?? false);
    if (cached?.prefetched) recordMessageCounter('prefetchHit');
    const dirty = Boolean(
      cached &&
        (cached.dirty || cached.revision !== revision || Date.now() - cached.verifiedAt > 30_000),
    );
    if (cached && !dirty && Date.now() - cached.verifiedAt < 3000) {
      // 完整首屏可能刚写入缓存，旧 effect 却在交付前被设置更新取消。
      // 新入口接过完整窗口及收尾，不能只跳过查询，留下旧入口的加载状态。
      if (entryLoadingRef.current) {
        loadedRef.current = cached.rows;
        verifiedWindowRowsRef.current = cached.rows;
        loadedRevisionRef.current = cached.revision;
        windowVerifiedAtRef.current = cached.verifiedAt;
        windowRef.current = { minSeq: cached.rows[0]?.msgSeq ?? null, anchored: cached.anchored };
        setLoaded(cached.rows);
        setHasOlder(cached.hasOlder);
        setHasNewer(cached.hasNewer);
        setAnchoredToLatest(cached.anchored);
        entryScrollIntentRef.current = null;
        entryLoadingRef.current = false;
        setMessagesLoading(false);
        setLoadingNewerMessages(false);
      }
      return () => {
        cancelled = true;
      };
    }
    if (!cached) setMessagesLoading(true);
    entryLoadingRef.current = true;
    setLoadingNewerMessages(false);
    if (cached?.anchored && readFromFirstUnread) {
      // 增量页失败后仍保留向下重试入口，也避免在途实时刷新抢占阅读窗口。
      setHasNewer(true);
      setAnchoredToLatest(false);
      windowRef.current = expectedWindow = { ...expectedWindow, anchored: false };
    }
    void (async () => {
      try {
        const recoveryPosition = !cached ? readRecoveryPosition(conv, kind) : undefined;
        const saved = recoveryPosition
          ? recoveryPosition.anchorSeq
            ? recoveryPosition
            : undefined
          : readFromFirstUnread
            ? conversationWindows.getPosition(conversationWindowKey(scope, kind, conv))
            : undefined;
        let readSeq = saved?.anchorSeq;
        let localShown = false;
        const entryStarted = performance.now();
        let firstRows = false;
        await loadConversationEntry<MessageWire>({
          cached,
          dirty,
          readSeq,
          readFromFirstUnread: recoveryPosition
            ? Boolean(recoveryPosition.anchorSeq)
            : (readFromFirstUnread ?? false),
          limit,
          current: valid,
          active,
          resolveReadSeq: async () => {
            try {
              const [info] = await readUnreadInfos({
                ...binding,
                targets: [{ chatType: entryChatType, uid: conv }],
              });
              if (info && !info.readError && (info.unreadCount ?? 0) > 0)
                readSeq = info.readSeq ?? undefined;
            } catch (error) {
              console.error('[msgs] entry unread snapshot failed', error);
            }
            return readSeq;
          },
          settled: () => {
            if (entryScrollIntentRef.current?.selection === selection)
              entryScrollIntentRef.current = null;
            entryLoadingRef.current = false;
            setMessagesLoading(false);
            setLoadingNewerMessages(false);
            if (!valid() || dbRevisionRef.current !== revision) void refreshWindow();
          },
          cursor: (rows) =>
            rows
              .filter(
                (row) => kind === 'group' || row.source !== 'roaming' || row.ntSeqVerified === true,
              )
              .map((row) => row.msgSeq)
              .filter((seq) => /^[1-9]\d*$/.test(seq))
              .reduce<string | undefined>(
                (max, seq) => (!max || BigInt(seq) > BigInt(max) ? seq : max),
                undefined,
              ),
          before: async (beforeSeq, size) =>
            (
              await client.account.listBefore.query({
                ...binding,
                readWindow: selection?.readWindow,
                deferReplyMedia: true,
                kind,
                conv,
                beforeSeq,
                limit: size,
              })
            ).map(toMessageWire),
          after: async (afterSeq, size) => {
            // 最新页校准与本地／漫游合并不是向下分页；只有实际读后续页才转圈。
            if (valid()) setLoadingNewerMessages(true);
            return (
              await client.account.listAfter.query({
                ...binding,
                readWindow: selection?.readWindow,
                deferReplyMedia: true,
                kind,
                conv,
                afterSeq,
                limit: size,
              })
            ).map(toMessageWire);
          },
          latest: async (size) =>
            (
              await measureMessagePhase('entryQuery', () =>
                client.account.listLatest.query({
                  ...binding,
                  kind,
                  conv,
                  limit: size,
                  readWindow: selection?.readWindow,
                  deferReplyMedia: true,
                }),
              )
            ).map(toMessageWire),
          progressiveLatest: async (size, show) => {
            try {
              if (IS_WEB && useWebConnection.getState().status !== 'connected')
                throw new Error('分阶段连接暂不可用');
              return await measureMessagePhase('entryQuery', () =>
                firstPages.read({ kind, conv, limit: size }, show),
              );
            } catch (error) {
              if (!valid()) throw error;
              recordMessageCounter('entryFallback');
              // 旧主进程尚未加载分阶段接口时，继续使用原有消息页，不让热更新阻断聊天。
              return (
                await measureMessagePhase('entryQuery', () =>
                  client.account.listLatest.query({
                    ...binding,
                    kind,
                    conv,
                    limit: size,
                    readWindow: selection?.readWindow,
                    deferReplyMedia: true,
                  }),
                )
              ).map(toMessageWire);
            }
          },
          show: (next, first, complete = true) => {
            if (!valid()) return;
            if (!complete && !localShown)
              entryScrollIntentRef.current = { selection, revision: null };
            if (!firstRows && next.rows.length) {
              recordMessagePhase('entryFirstRows', performance.now() - entryStarted);
              firstRows = true;
            }
            recoveryPositionApplied();
            if (first && readSeq) {
              setInitialReadingPosition(
                saved ?? {
                  scrollTop: 0,
                  anchorId: next.rows.length ? timelineRowKey(next.rows.at(-1)!) : undefined,
                  alignToEnd: true,
                  bottomInset: 64,
                },
              );
            } else if (!first) {
              const scroll = nativeMessageScrollRef.current;
              const intent = entryScrollIntentRef.current;
              const interacted =
                intent?.selection === selection &&
                intent.revision !== null &&
                intent.revision !==
                  (scroll ? timelineViewport(scroll)?.scrollRevision?.() : undefined);
              if (
                scroll &&
                (!localShown ||
                  interacted ||
                  readFromFirstUnread ||
                  recoveryPosition ||
                  !next.anchored ||
                  scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 48)
              ) {
                const position = captureReadingPosition(scroll, { transient: true });
                if (position.anchorId) cachedScrollRef.current = { id: conv, position };
              }
            }
            const page = mergeRoamingTimeline(kind, next.rows, []);
            const rows =
              complete && localShown ? mergeRefreshedWindow(loadedRef.current, page, limit) : page;
            if (!complete) localShown = true;
            loadedRevisionRef.current = revision;
            windowVerifiedAtRef.current = complete ? Date.now() : 0;
            windowRef.current = expectedWindow = {
              minSeq: rows[0]?.msgSeq ?? null,
              anchored: next.anchored,
            };
            loadedRef.current = rows;
            pendingMessageCommit.current = performance.now();
            setLoaded(rows);
            setHasOlder(next.hasOlder);
            setHasNewer(next.hasNewer);
            setAnchoredToLatest(next.anchored);
            setMessagesLoading(!complete);
            verifiedWindowRowsRef.current = complete ? rows : null;
          },
        });
      } catch (err) {
        if (!valid()) return;
        console.error('[msgs] entry load failed', err);
        setMessagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    selectedUid,
    isDirect,
    isGroup,
    centerWindowOnSeq,
    entryChatType,
    readFromFirstUnread,
    messageScope,
    conversationWindows,
    refreshWindow,
    readRecoveryPosition,
    recoveryPositionApplied,
    firstPages,
    setLoaded,
    messageBindingRef,
    setMessagesLoading,
    selectionRef,
    dbRevisionRef,
    windowRef,
    messageScopeRef,
    pendingSearchJumpRef,
    entryLoadingRef,
    loadedRef,
    verifiedWindowRowsRef,
    loadedRevisionRef,
    windowVerifiedAtRef,
    setHasOlder,
    setHasNewer,
    setAnchoredToLatest,
    entryScrollIntentRef,
    setLoadingNewerMessages,
    setInitialReadingPosition,
    nativeMessageScrollRef,
    cachedScrollRef,
    pendingMessageCommit,
  ]);

  const requestOlderMessages = useCallback(
    (scroll: HTMLElement): void => {
      if (
        !isConversationPagingVisible(scroll) ||
        !selectedConversation ||
        !hasOlder ||
        loadingOlderRef.current ||
        loadingNewerRef.current ||
        entryLoadingRef.current ||
        messagesLoading
      )
        return;
      if (pendingScrollRestoreRef.current !== null) return;
      const minSeq = loaded[0]?.msgSeq;
      if (!minSeq) return;

      const kind = selectedConversation.type === 'group' ? 'group' : 'c2c';
      const conv = selectedConversation.id;
      const scope = messageScopeRef.current,
        binding = messageBindingRef.current,
        selection = selectionRef.current;
      if (!scope || !binding || selection?.id !== conv) return;
      loadingOlderRef.current = true;

      client.account.listBefore
        .query({
          ...binding,
          kind,
          conv,
          beforeSeq: minSeq,
          limit: PAGE_SIZE,
          readWindow: selection.readWindow,
          deferReplyMedia: true,
        })
        .then((older) => {
          if (messageScopeRef.current !== scope || selectionRef.current !== selection) return;
          loadingOlderRef.current = false;
          if (!isConversationPagingVisible(scroll)) return;
          if (windowRef.current.minSeq !== minSeq) {
            return;
          }
          if (selectionRef.current?.id !== conv) {
            pendingScrollRestoreRef.current = null;
            return;
          }
          const known = new Set(loaded.map(timelineRowKey));
          const fresh = older
            .map(toMessageWire)
            .reverse()
            .filter((m) => !known.has(timelineRowKey(m))); // ASC, older than the window
          if (fresh.length === 0) {
            pendingScrollRestoreRef.current = null;
            setHasOlder(false);
            return;
          }
          // 请求期间用户仍可滚动；只在真正提交旧页前捕获此刻的可见消息。
          pendingScrollRestoreRef.current = {
            conversationId: conv,
            position: captureReadingPosition(scroll, { transient: true }),
          };
          setLoaded((cur) => {
            const seen = new Set(cur.map(timelineRowKey));
            const merged = fresh.filter((m) => !seen.has(timelineRowKey(m)));
            return merged.length ? [...merged, ...cur] : cur;
          });
          if (older.length < PAGE_SIZE) setHasOlder(false);
        })
        .catch((err) => {
          if (messageScopeRef.current !== scope || selectionRef.current !== selection) return;
          loadingOlderRef.current = false;
          pendingScrollRestoreRef.current = null;
          console.error('[msgs] listBefore failed', err);
        });
    },
    [
      selectedConversation,
      hasOlder,
      loaded,
      messagesLoading,
      setLoaded,
      loadingOlderRef,
      loadingNewerRef,
      entryLoadingRef,
      pendingScrollRestoreRef,
      messageScopeRef,
      messageBindingRef,
      selectionRef,
      windowRef,
      setHasOlder,
    ],
  );

  // Scroll-down paging for a detached "jump context" window: append the page of
  // messages just newer than the window's tail. Appending below the viewport
  // doesn't move it, so no scroll-restore is needed. When the tail reaches the
  // latest, re-anchor so live messages flow in again.
  const requestNewerMessages = useCallback(
    (scroll: HTMLElement): void => {
      if (
        !isConversationPagingVisible(scroll) ||
        !selectedConversation ||
        !hasNewer ||
        loadingNewerRef.current ||
        loadingOlderRef.current ||
        pendingScrollRestoreRef.current ||
        entryLoadingRef.current
      )
        return;
      const maxSeq = loaded[loaded.length - 1]?.msgSeq;
      if (!maxSeq) return;

      const kind = selectedConversation.type === 'group' ? 'group' : 'c2c';
      const conv = selectedConversation.id;
      const scope = messageScopeRef.current,
        binding = messageBindingRef.current,
        selection = selectionRef.current;
      if (!scope || !binding || selection?.id !== conv) return;
      loadingNewerRef.current = true;
      setLoadingNewerMessages(true);

      client.account.listAfter
        .query({
          ...binding,
          kind,
          conv,
          afterSeq: maxSeq,
          limit: PAGE_SIZE,
          readWindow: selection.readWindow,
          deferReplyMedia: true,
        })
        .then((newer) => {
          if (messageScopeRef.current !== scope || selectionRef.current !== selection) return;
          loadingNewerRef.current = false;
          setLoadingNewerMessages(false);
          if (!isConversationPagingVisible(scroll)) return;
          if (loadedRef.current.at(-1)?.msgSeq !== maxSeq) return;
          if (selectionRef.current?.id !== conv) return;
          const known = new Set(loaded.map(timelineRowKey));
          const fresh = newer.map(toMessageWire).filter((m) => !known.has(timelineRowKey(m))); // ASC, newer
          if (fresh.length > 0) {
            setLoaded((cur) => {
              const seen = new Set(cur.map(timelineRowKey));
              const merged = fresh.filter((m) => !seen.has(timelineRowKey(m)));
              return merged.length ? [...cur, ...merged] : cur;
            });
          }
          if (newer.length < PAGE_SIZE) {
            // Reached the tail — fold this window back into the live "latest" view.
            setHasNewer(false);
            setAnchoredToLatest(true);
          }
        })
        .catch((err) => {
          if (messageScopeRef.current !== scope || selectionRef.current !== selection) return;
          loadingNewerRef.current = false;
          setLoadingNewerMessages(false);
          console.error('[msgs] listAfter failed', err);
        });
    },
    [
      selectedConversation,
      hasNewer,
      loaded,
      setLoaded,
      loadingNewerRef,
      loadingOlderRef,
      pendingScrollRestoreRef,
      entryLoadingRef,
      messageScopeRef,
      messageBindingRef,
      selectionRef,
      setLoadingNewerMessages,
      loadedRef,
      setHasNewer,
      setAnchoredToLatest,
    ],
  );

  useLayoutEffect(() => {
    if (!messagesTabActive) return undefined;
    const restore = pendingScrollRestoreRef.current;
    if (!restore || restore.conversationId !== selectedConversation?.id) return undefined;

    const scroll = nativeMessageScrollRef.current;
    if (!scroll) return undefined;

    // 只跟随锚点上方的变化，底部追加和图片展开不能计入向上翻页补偿。
    restoreReadingPosition(scroll, restore.position);
    const appliedTop = scroll.scrollTop;
    const frame = window.requestAnimationFrame(() => {
      if (pendingScrollRestoreRef.current !== restore) return;
      // 用户在首帧后继续滚动时，不用旧快照把他拉回。
      if (isConversationPagingVisible(scroll) && Math.abs(scroll.scrollTop - appliedTop) <= 1)
        restoreReadingPosition(scroll, restore.position);
      pendingScrollRestoreRef.current = null;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    messagesTabActive,
    selectedConversation?.id,
    messageCount,
    pendingScrollRestoreRef,
    nativeMessageScrollRef,
  ]);

  return { requestOlderMessages, requestNewerMessages };
}
