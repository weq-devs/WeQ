import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '../../trpc/client';
import { useStableCallback } from '../../hooks/useStableCallback';
import { stageAccountFile } from '../../lib/accountFilePicker';
import { resolveDraftSave } from '../../lib/draftPersistence';
import {
  rememberClientRetry,
  forgetClientRetry,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { client } from '../../trpc/client';
import { useToast } from '../../components/Toast.shared';
import {
  notificationSource,
  conversationNotificationSource,
} from '../../lib/notificationNavigation.shared';
import { composerDraftRecovery, type ComposerDraftSnapshot } from '../../lib/composerDraftRecovery';
import {
  composerAssetIds,
  removeUnusedComposerImages,
  shareComposerImages,
} from '../../lib/composerDraftMedia';
import type { Conversation, ConversationDrafts } from '../../im-template/template/types';
import {
  composerTextToElements,
  elementsToComposerText,
  toIpcElements,
} from '../../im-template/template/draftElements';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import {
  composerSpeechText,
  updateComposerSpeechText,
} from '../../im-template/template/composer.shared';

type DraftInput = {
  binding: QQWriteBinding | null;
  messageScope: string;
  openedUin: string | null;
  activeConversationId: string | null;
  resolveConversation: (id: string) => Conversation | undefined;
};

function applyDraft(drafts: ConversationDrafts, conversationId: string, text: string) {
  if (text) drafts[conversationId] = text;
  else delete drafts[conversationId];
}

/** 输入时记录恢复快照，离开会话、切页及退出时同步 QQ 草稿。 */
export function useWorkspaceDrafts(input: DraftInput) {
  const { binding, messageScope, openedUin, activeConversationId } = input;
  const resolveConversation = useStableCallback(input.resolveConversation);
  const pushToast = useToast((state) => state.push);
  const messageScopeRef = useRef(messageScope);
  messageScopeRef.current = messageScope;
  const messageBindingRef = useRef(binding);
  messageBindingRef.current = binding;
  const activeConversationRef = useRef(activeConversationId);
  activeConversationRef.current = activeConversationId;
  const source = useMemo(() => ({}), [messageScope]);
  const sourceRef = useRef<object | null>(source);
  sourceRef.current = source;
  const isCurrent = useCallback(
    () => messageScopeRef.current === messageScope && sourceRef.current === source,
    [messageScope, source],
  );
  useEffect(() => {
    messageScopeRef.current = messageScope;
    sourceRef.current = source;
    return () => {
      messageScopeRef.current = '';
      sourceRef.current = null;
    };
  }, [messageScope, source]);
  // 输入先同步保存本机恢复快照；离开时继续写 QQ 草稿，成功后再确认对应快照。
  const [drafts, setDrafts] = useState<ConversationDrafts>({});
  const savedDraftsRef = useRef(new Map<string, { body: string; version: string | null }>());
  // 这里只保留未确认的编辑，空串表示清空；每次编辑的对象身份用来识别迟到的保存。
  const pendingDraftsRef = useRef(new Map<string, ComposerDraftSnapshot>());
  const draftRecoveryFailed = useRef(false);
  useEffect(() => {
    try {
      if (!messageScope) return;
      composerDraftRecovery.migrate(openedUin ?? '', messageScope);
      const recovered = composerDraftRecovery.loadSnapshots(messageScope);
      pendingDraftsRef.current = new Map(Object.entries(recovered));
      savedDraftsRef.current.clear();
      const next: ConversationDrafts = {};
      for (const [id, snapshot] of Object.entries(recovered)) applyDraft(next, id, snapshot.body);
      setDrafts(next);
    } catch {
      pushToast({
        key: 'composer-draft-storage',
        tone: 'error',
        title: '无法读取本机草稿',
        source: notificationSource({ kind: 'app', target: { kind: 'view', view: 'messages' } }),
        detail: '恢复快照已保留，请勿清理应用数据；本次输入暂时只保存在内存中。',
      });
      draftRecoveryFailed.current = true;
    }
  }, [openedUin, messageScope, pushToast]);
  /** 失败重试总是使用当前控制器，不保留离开前的会话目录闭包。 */
  const flushDraftRef = useRef<(conversationId: string) => Promise<void>>(async () => {});
  /**
   * 把「还没落库的正文」并进 state —— 切走会话后立刻切回来能回填、会话列表的草稿
   * 标记也要亮。flushDraft 是异步的（落库完成前 state 不会动），所以不能只靠它。
   */
  const syncDraftsFromPending = useCallback((): void => {
    setDrafts((current) => {
      const next = { ...current };
      for (const [id, pending] of pendingDraftsRef.current) applyDraft(next, id, pending.body);
      return next;
    });
  }, []);

  /**
   * 普通输入只更新 ref 和恢复快照，避免逐字重渲 MainView。清空也立即更新回填用的
   * state，避免页面重挂时读到上一份正文。
   */
  const updateDraft = useCallback(
    (conversationId: string, value: string): void => {
      if (!isCurrent()) return;
      const previous = pendingDraftsRef.current.get(conversationId);
      if (previous?.body === value && !draftRecoveryFailed.current) return;
      const baseVersion = previous
        ? previous.body === '' && value !== ''
          ? null
          : previous.baseVersion
        : (savedDraftsRef.current.get(conversationId)?.version ?? null);
      pendingDraftsRef.current.set(conversationId, { body: value, baseVersion });
      if (value === '') {
        setDrafts((current) => {
          if (!Object.hasOwn(current, conversationId)) return current;
          const next = { ...current };
          applyDraft(next, conversationId, value);
          return next;
        });
      }
      try {
        composerDraftRecovery.write(messageScope, conversationId, value, baseVersion);
        draftRecoveryFailed.current = false;
      } catch {
        if (!draftRecoveryFailed.current)
          pushToast({
            key: 'composer-draft-storage',
            tone: 'error',
            title: '草稿自动保存失败',
            source: conversationNotificationSource({
              id: conversationId,
              type: resolveConversation(conversationId)?.type ?? 'direct',
            }),
            detail: '当前输入仍在界面中，但本次修改未能持久保存，请先保留内容再重启。',
          });
        draftRecoveryFailed.current = true;
      }
    },
    [messageScope, pushToast, resolveConversation, isCurrent],
  );

  // 本机未保存的编辑优先展示；已保存的草稿跟随 QQ 库刷新。
  const draftQuery = trpc.account.listDrafts.useQuery(binding ?? undefined, {
    enabled: Boolean(binding),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  useEffect(() => {
    const rows = draftQuery.data;
    if (!rows) return;
    const next: ConversationDrafts = {};
    savedDraftsRef.current.clear();
    for (const row of rows) {
      // 行键里的 targetUid 就是会话 id（c2c 是 uid、群是群号）。
      const text = elementsToComposerText(row.elements ?? []);
      savedDraftsRef.current.set(row.targetUid, { body: text, version: row.version });
      applyDraft(next, row.targetUid, text);
    }
    // 不覆盖本次会话里已经改过、还没落库的那几条 —— 以 pendingDraftsRef 为准
    // （state 里的副本可能还没跟上）。
    for (const [id, pending] of pendingDraftsRef.current) applyDraft(next, id, pending.body);
    setDrafts(next);
  }, [draftQuery.data]);

  /**
   * 离开时写回 QQ 库（或清掉）；失败时保留本机恢复快照与脏标记。
   */
  const flushDraft = useCallback(
    async (conversationId: string): Promise<void> => {
      const draftBinding = messageBindingRef.current;
      if (!draftBinding || !isCurrent()) return;
      const pending = pendingDraftsRef.current.get(conversationId);
      if (!pending) return;
      const stillPending = () =>
        isCurrent() && pendingDraftsRef.current.get(conversationId) === pending;
      // 主列表之外，隐藏会话 / 最近删除的会话也可能是当前打字的那个，都要能落库。
      const conv = resolveConversation(conversationId);
      if (!conv) return;
      const peer =
        conv.type === 'group'
          ? ({ kind: 'group', targetUid: conv.group.identityValue } as const)
          : conv.type === 'direct'
            ? ({ kind: 'c2c', targetUid: conv.otherUser.id } as const)
            : null;
      if (!peer) return;
      const text = pending.body;
      let savedText = text;
      try {
        const sharedBody = await shareComposerImages(
          messageScope,
          conversationId,
          text,
          async (file) => {
            const staged = await stageAccountFile(file, draftBinding);
            try {
              return (
                await client.clientState.keepDraftMedia.mutate({
                  ...draftBinding,
                  uploadId: staged.uploadId,
                })
              ).path;
            } finally {
              void client.account.pickedFileDiscard
                .mutate({ ...draftBinding, uploadId: staged.uploadId })
                .catch(() => {});
            }
          },
          undefined,
          openedUin ?? undefined,
        );
        if (!stillPending()) return;
        savedText = sharedBody;
        const elements = toIpcElements(composerTextToElements(sharedBody));
        const result = await resolveDraftSave(
          `chat:${peer.kind}:${peer.targetUid}`,
          elements,
          pending.baseVersion,
          (expectedVersion) => {
            if (!stillPending()) throw new Error('草稿已更新');
            return client.account.saveDraft.mutate({
              ...draftBinding,
              kind: peer.kind,
              targetUid: peer.targetUid,
              elements,
              expectedVersion,
            });
          },
        );
        if (!isCurrent()) return;
        if (!result.local)
          savedText = elementsToComposerText(
            Array.isArray(result.current.value) ? result.current.value : [],
          );
        if (result.local || stillPending())
          savedDraftsRef.current.set(conversationId, {
            body: savedText,
            version: result.current.version,
          });
      } catch (e) {
        if (!stillPending()) return;
        // QQ 写入失败不能删除恢复快照，下次离开时仍可重试。
        rememberClientRetry(`chat:${messageScope}:${conversationId}`, async () => {
          if (messageScopeRef.current !== messageScope) {
            useClientPreferences.setState({ error: '请返回原账号后重试聊天草稿保存' });
            return;
          }
          await flushDraftRef.current(conversationId);
        });
        useClientPreferences.setState({
          error: `聊天草稿未保存：${e instanceof Error ? e.message : String(e)}`,
        });
        console.error('[MainView] Failed to save draft:', e);
        return;
      }
      // 用户可能在写库期间继续编辑，旧回执只能确认它对应的那次编辑。
      if (!stillPending()) return;
      pendingDraftsRef.current.delete(conversationId);
      forgetClientRetry(`chat:${messageScope}:${conversationId}`);
      try {
        // QQ wire 草稿不保留本机素材标识；带图片的恢复快照需保留到用户清空/发送。
        if (!composerAssetIds(savedText).size)
          composerDraftRecovery.confirm(messageScope, conversationId, text, pending.baseVersion);
        if (savedText !== text && activeConversationRef.current !== conversationId) {
          const ids = composerAssetIds(text);
          if (ids.size)
            void removeUnusedComposerImages(messageScope, conversationId, ids).catch(() => {});
        }
      } catch {
        /* 保留快照，不能因清理失败丢稿。 */
      }
      setDrafts((current) => {
        const next = { ...current };
        applyDraft(next, conversationId, savedText);
        return next;
      });
    },
    [resolveConversation, openedUin, messageScope, isCurrent],
  );

  /**
   * 所有还在钉着的会话离开当前窗口 —— 一次把脏草稿全落库。
   * 用在「离开消息页」与「应用退出」这两个场合。
   */
  const flushAllDirtyDrafts = useCallback((): void => {
    if (!pendingDraftsRef.current.size) return;
    syncDraftsFromPending();
    for (const id of pendingDraftsRef.current.keys()) void flushDraft(id);
  }, [flushDraft, syncDraftsFromPending]);
  flushDraftRef.current = (conversationId: string) => {
    return flushDraft(conversationId);
  };

  // 退出时尽力同步 QQ；崩溃保护由输入时的同步恢复快照承担，不依赖此回调。
  useEffect(() => {
    const onUnload = (): void => {
      const draftBinding = messageBindingRef.current;
      if (!draftBinding || messageScopeRef.current !== messageScope) return;
      for (const [id, pending] of pendingDraftsRef.current) {
        const conv = resolveConversation(id);
        if (!conv) continue;
        const peer =
          conv.type === 'group'
            ? { kind: 'group' as const, targetUid: conv.group.identityValue }
            : conv.type === 'direct'
              ? { kind: 'c2c' as const, targetUid: conv.otherUser.id }
              : null;
        if (!peer) continue;
        if (composerAssetIds(pending.body).size) continue;
        // 同步路径上 fire-and-forget：unload 阶段拿不到 await 的机会。
        void client.account.saveDraft
          .mutate({
            ...draftBinding,
            expectedVersion: pending.baseVersion,
            kind: peer.kind,
            targetUid: peer.targetUid,
            // 空串 = 清掉草稿（见 `@weq/service/draft-edit`）。
            elements: toIpcElements(composerTextToElements(pending.body)),
          })
          .catch(() => undefined);
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [resolveConversation, messageScope]);

  /**
   * 离开会话的**唯一收口点**：`activeConversationId` 一变，就把上一个会话的脏草稿
   * 写回库。私聊 A 打了一半切到 B ⇒ 这一步落库 A 的草稿（正文为空则清掉）。
   *
   * 之所以不用各调用点自己 flush：离开会话有四条路径 —— 点侧边栏、会话内「返回」、
   * 搜索结果 / 文件跳转、从隐藏 / 删除 / 官方号选择器进入。它们各自调
   * `shell.selectConversation` 或 `shell.backConversation`，只有第一条以前会落库。
   * 盯住这一个状态，四条路径就都覆盖了。
   */
  const prevActiveConvRef = useRef<string | null>(activeConversationId);
  useEffect(() => {
    const prev = prevActiveConvRef.current;
    prevActiveConvRef.current = activeConversationId;
    if (!prev || prev === activeConversationId) return;
    flushDraftRef.current(prev);
    syncDraftsFromPending();
  }, [activeConversationId, syncDraftsFromPending]);

  const clearSentSpeechDraft = useCallback(
    (conversationId: string, text: string) => {
      if (!isCurrent()) return;
      const current =
        pendingDraftsRef.current.get(conversationId)?.body ??
        savedDraftsRef.current.get(conversationId)?.body ??
        '';
      if (composerSpeechText(current).trim() !== text) return;
      updateDraft(conversationId, updateComposerSpeechText(current, ''));
      syncDraftsFromPending();
      void flushDraftRef.current(conversationId);
    },
    [isCurrent, syncDraftsFromPending, updateDraft],
  );
  return { drafts, updateDraft, clearSentSpeechDraft, syncDraftsFromPending, flushAllDirtyDrafts };
}
