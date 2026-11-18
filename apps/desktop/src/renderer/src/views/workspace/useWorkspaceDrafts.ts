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
import { localDraftToWrite, setLocalDraft } from '@weq/service/draft-edit';
import { composerDraftRecovery } from '../../lib/composerDraftRecovery';
import { composerAssetIds, shareComposerImages } from '../../lib/composerDraftMedia';
import type { Conversation, ConversationDrafts } from '../../im-template/template/types';
import {
  composerTextToElements,
  elementsToComposerText,
  toIpcElements,
} from '../../im-template/template/draftElements';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';

type DraftInput = {
  binding: QQWriteBinding | null;
  messageScope: string;
  openedUin: string | null;
  activeConversationId: string | null;
  resolveConversation: (id: string) => Conversation | undefined;
};

/** 输入只写 ref 和恢复快照；离开会话、切页及退出复用同一保存控制器。 */
export function useWorkspaceDrafts(input: DraftInput) {
  const { binding, messageScope, openedUin, activeConversationId } = input;
  const resolveConversation = useStableCallback(input.resolveConversation);
  const pushToast = useToast((state) => state.push);
  const messageScopeRef = useRef(messageScope);
  messageScopeRef.current = messageScope;
  const messageBindingRef = useRef(binding);
  messageBindingRef.current = binding;
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
  const [drafts, setDrafts] = useState<ConversationDrafts>(() => {
    try {
      return composerDraftRecovery.load(messageScope);
    } catch {
      return {};
    }
  });
  /** 本次会话里被改过、还没落库的会话 id。 */
  const dirtyDraftsRef = useRef<Set<string>>(new Set(Object.keys(drafts)));
  const draftVersionsRef = useRef(new Map<string, string | null>());
  /**
   * 还没落库的草稿正文（输入框实时值）。**刻意用 ref 而不是 state** —— 每敲一个
   * 字都 setState 会让整棵 MainView 重渲，这是之前输入卡顿的主因。它只在「切会话 /
   * 离开消息页 / 退出」时被读取并并进 state 或落库。
   */
  const pendingDraftsRef = useRef<ConversationDrafts>({ ...drafts });
  const draftRecoveryFailed = useRef(false);
  useEffect(() => {
    try {
      if (!messageScope) return;
      composerDraftRecovery.migrate(openedUin ?? '', messageScope);
      const recovered = composerDraftRecovery.load(messageScope);
      pendingDraftsRef.current = { ...recovered };
      dirtyDraftsRef.current = new Set(Object.keys(recovered));
      draftVersionsRef.current.clear();
      setDrafts(recovered);
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
      for (const [id, text] of Object.entries(pendingDraftsRef.current)) {
        if (text.length) next[id] = text;
        else delete next[id];
      }
      return next;
    });
  }, []);

  /**
   * 输入框改动同步写恢复快照并记在 ref 里，不碰 React state —— 每敲一个字都 setState 会让
   * 整棵 MainView（含侧边栏 + 聊天区）重渲，这正是之前输入卡顿的主因。
   * 真正的 state 更新与落库都推迟到 flushDraft（离开会话 / 离开消息页 / 退出）。
   */
  const updateDraft = useCallback(
    (conversationId: string, value: string): void => {
      if (!isCurrent()) return;
      try {
        composerDraftRecovery.write(messageScope, conversationId, value);
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
      // 清空要**保留 key、存空串**（不是 delete）—— 规则与理由见
      // `@weq/service/draft-edit`：`delete` 会让「清空了」和「没动过」不可区分，
      // 落库时就会把上一次的旧正文再写回去。
      pendingDraftsRef.current = setLocalDraft(pendingDraftsRef.current, conversationId, value);
      dirtyDraftsRef.current.add(conversationId);
    },
    [messageScope, pushToast, resolveConversation, isCurrent],
  );

  // 进入消息页时把 QQ 库里已有的草稿读进来（整表只有几行）。这是唯一一次读 ——
  // 本机恢复快照优先于 QQ 旧草稿；输入时不逐字写 QQ 库。
  const draftQuery = trpc.account.listDrafts.useQuery(binding ?? undefined, {
    enabled: Boolean(binding),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  useEffect(() => {
    const rows = draftQuery.data;
    if (!rows) return;
    const next: ConversationDrafts = {};
    for (const row of rows) {
      if (!dirtyDraftsRef.current.has(row.targetUid))
        draftVersionsRef.current.set(row.targetUid, row.version);
      // 行键里的 targetUid 就是会话 id（c2c 是 uid、群是群号）。
      const text = elementsToComposerText(row.elements ?? []);
      if (text.length) next[row.targetUid] = text;
    }
    // 不覆盖本次会话里已经改过、还没落库的那几条 —— 以 pendingDraftsRef 为准
    // （state 里的副本可能还没跟上）。
    const merged: ConversationDrafts = { ...next };
    for (const id of dirtyDraftsRef.current) {
      const local = pendingDraftsRef.current[id];
      if (local) merged[id] = local;
      else delete merged[id];
    }
    setDrafts(merged);
  }, [draftQuery.data]);

  /**
   * 离开时写回 QQ 库（或清掉）；失败时保留本机恢复快照与脏标记。
   */
  const flushDraft = useCallback(
    async (conversationId: string): Promise<void> => {
      const draftBinding = messageBindingRef.current;
      if (!draftBinding || !isCurrent()) return;
      if (!dirtyDraftsRef.current.has(conversationId)) return;
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
      // 脏会话在 pendingDraftsRef 里一定有值（含空串 = 用户已清空）。只读它，
      // 绝不回退到已落库的旧正文 —— 那正是「删了内容草稿还在」的根因。
      const text = localDraftToWrite(pendingDraftsRef.current, conversationId);
      let savedText = text;
      try {
        const sharedBody = await shareComposerImages(
          openedUin ?? '',
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
        );
        if (!isCurrent()) return;
        savedText = sharedBody;
        const elements = toIpcElements(composerTextToElements(sharedBody));
        const result = await resolveDraftSave(
          `chat:${peer.kind}:${peer.targetUid}`,
          elements,
          draftVersionsRef.current.get(conversationId) ?? null,
          (expectedVersion) =>
            client.account.saveDraft.mutate({
              ...draftBinding,
              kind: peer.kind,
              targetUid: peer.targetUid,
              elements,
              expectedVersion,
            }),
        );
        if (!isCurrent()) return;
        draftVersionsRef.current.set(conversationId, result.current.version);
        if (!result.local)
          savedText = elementsToComposerText(
            Array.isArray(result.current.value) ? result.current.value : [],
          );
      } catch (e) {
        if (!isCurrent()) return;
        // QQ 写入失败不能删除恢复快照，下次离开时仍可重试。
        dirtyDraftsRef.current.add(conversationId);
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
      // 落库成功后再同步一次 state —— 会话列表的草稿标记 / 切回来时的回填都读它。
      // 每次「离开」最多一次，不会退回逐字重渲。
      // 写库是异步的：期间用户可能又切回这个会话接着改（pending 已变、dirty 已重置）。
      // 那种情况下这次落库的结果已经不是最新的，state 不能拿它盖掉新正文。
      if (localDraftToWrite(pendingDraftsRef.current, conversationId) !== text) return;
      dirtyDraftsRef.current.delete(conversationId);
      forgetClientRetry(`chat:${messageScope}:${conversationId}`);
      pendingDraftsRef.current[conversationId] = savedText;
      if (savedText !== text) composerDraftRecovery.write(messageScope, conversationId, savedText);
      try {
        // QQ wire 草稿不保留本机素材标识；带图片的恢复快照需保留到用户清空/发送。
        if (!composerAssetIds(savedText).size)
          composerDraftRecovery.confirm(messageScope, conversationId, savedText);
      } catch {
        /* 保留快照，不能因清理失败丢稿。 */
      }
      setDrafts((current) => {
        const next = { ...current };
        if (savedText.length) next[conversationId] = savedText;
        else delete next[conversationId];
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
    for (const id of [...dirtyDraftsRef.current]) void flushDraft(id);
  }, [flushDraft]);
  flushDraftRef.current = (conversationId: string) => {
    return flushDraft(conversationId);
  };

  // 退出时尽力同步 QQ；崩溃保护由输入时的同步恢复快照承担，不依赖此回调。
  useEffect(() => {
    const onUnload = (): void => {
      const draftBinding = messageBindingRef.current;
      if (!draftBinding || messageScopeRef.current !== messageScope) return;
      for (const id of [...dirtyDraftsRef.current]) {
        const conv = resolveConversation(id);
        if (!conv) continue;
        const peer =
          conv.type === 'group'
            ? { kind: 'group' as const, targetUid: conv.group.identityValue }
            : conv.type === 'direct'
              ? { kind: 'c2c' as const, targetUid: conv.otherUser.id }
              : null;
        if (!peer) continue;
        if (composerAssetIds(localDraftToWrite(pendingDraftsRef.current, id)).size) continue;
        // 同步路径上 fire-and-forget：unload 阶段拿不到 await 的机会。
        void client.account.saveDraft
          .mutate({
            ...draftBinding,
            expectedVersion: draftVersionsRef.current.get(id) ?? null,
            kind: peer.kind,
            targetUid: peer.targetUid,
            // 空串 = 清掉草稿（见 `@weq/service/draft-edit`）。
            elements: toIpcElements(
              composerTextToElements(localDraftToWrite(pendingDraftsRef.current, id)),
            ),
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

  return { drafts, updateDraft, syncDraftsFromPending, flushAllDirtyDrafts };
}
