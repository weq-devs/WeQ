import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, Message } from '../im-template/template/types';
import type { useContentMultiSelect } from '../state/contentSelection';
import { useDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { runMessageLoadTask } from '../components/MessageLoadTask';
import { grayTipOf } from '../im-template/template/messageRow';
import { createSelectionGapIndex } from '../lib/selectionGapIndex';
import {
  messageSelectionItems,
  parseSelectionGap,
  selectionGapId,
  selectionGapsBetween,
  mergeSelectionGaps,
  type SelectionGap,
  type SelectionModifiers,
  type LoadSelectionMessages,
  isLocalOutgoingMessage,
} from '../lib/messageSelection';

const messageSequence = (message: Message | undefined, privateChat: boolean) =>
  message?.msgSeq &&
  /^[1-9]\d*$/.test(message.msgSeq) &&
  !(privateChat && message.sourceFormat === 'protocol' && !message.ntSeqVerified)
    ? BigInt(message.msgSeq)
    : null;

export function useMessageSelectionFlow({
  conversation,
  messages,
  selection,
  onLoad,
  missingJumpSeq,
  active,
}: {
  conversation: Conversation | null;
  messages: readonly Message[];
  selection: ReturnType<typeof useContentMultiSelect>;
  onLoad?: LoadSelectionMessages;
  missingJumpSeq?: string | null;
  active: boolean;
}) {
  const owner = `${conversation?.type}:${conversation?.id}`;
  const cache = selection.messageCache;
  const seqOf = useCallback(
    (message: Message | undefined) => messageSequence(message, conversation?.type === 'direct'),
    [conversation?.type],
  );
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const latest = useRef({ owner, cache, active });
  latest.current = { owner, cache, active };
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    return () => {
      request.current?.abort();
      for (const id of cache.keys())
        if (!selection.selectedIdsRef.current.has(id) && selection.anchorRef.current !== id)
          cache.delete(id);
    };
  }, [owner, cache, selection.selectedIdsRef, selection.anchorRef]);
  useEffect(() => {
    if (!active) request.current?.abort();
  }, [active]);
  const items = useMemo(
    () => messageSelectionItems(messages, selection.selectionMode, missingJumpSeq),
    [messages, selection.selectionMode, missingJumpSeq],
  );
  const order = useMemo(() => items.map((item) => item.id), [items]);
  const itemsById = useMemo(() => {
    const byId = new Map<string, (typeof items)[number]>();
    for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
    return byId;
  }, [items]);
  const messagesById = useMemo(
    () => new Map(messages.map((message, index) => [message.id, { message, index }])),
    [messages],
  );
  const gaps = useMemo(
    () =>
      [...selection.selectedIds].flatMap((id) => {
        const gap = parseSelectionGap(id);
        return gap ? [gap] : [];
      }),
    [selection.selectedIds],
  );
  const gapIndex = useMemo(() => createSelectionGapIndex(gaps), [gaps]);
  const gapSelected = useCallback((gap: SelectionGap) => gapIndex.containsGap(gap), [gapIndex]);
  useLayoutEffect(() => {
    const identity = (message: Message) => {
      const seq = seqOf(message);
      if (seq === null || grayTipOf(message)) return [];
      const keys: string[] = [];
      if (message.msgId && message.msgId !== '0') keys.push(`id:${seq}:${message.msgId}`);
      if (message.msgRandom && message.msgRandom !== '0')
        keys.push(`random:${seq}:${message.senderId}:${message.msgRandom}`);
      return keys;
    };
    const oldIdentities = new Map<string, Message[]>();
    for (const previous of cache.values())
      if (
        (previous.source === 'roaming' || isLocalOutgoingMessage(previous)) &&
        (selection.selectedIds.has(previous.id) || selection.anchorRef.current === previous.id)
      )
        for (const key of identity(previous))
          oldIdentities.set(key, [...(oldIdentities.get(key) ?? []), previous]);
    const replacements = new Map<string, Message>();
    if (oldIdentities.size)
      for (const message of messages)
        if (
          !isLocalOutgoingMessage(message) &&
          (message.source !== 'roaming' || message.sourceFormat === 'native' || message.localSent)
        )
          for (const key of identity(message))
            for (const previous of oldIdentities.get(key) ?? [])
              if (previous.id !== message.id) replacements.set(previous.id, message);
    if (replacements.size) {
      for (const [id, message] of replacements) {
        cache.delete(id);
        cache.set(message.id, message);
        if (selection.anchorRef.current === id) selection.anchorRef.current = message.id;
      }
      selection.setSelectedIds(
        (previous) => new Set([...previous].map((id) => replacements.get(id)?.id ?? id)),
      );
      return;
    }
    for (const id of new Set([...selection.selectedIds, selection.anchorRef.current])) {
      if (!id) continue;
      const message = messagesById.get(id)?.message;
      if (message) cache.set(id, message);
    }
    if (!busy)
      for (const id of cache.keys())
        if (!selection.selectedIds.has(id) && selection.anchorRef.current !== id) cache.delete(id);
  }, [
    messages,
    messagesById,
    selection.selectedIds,
    selection.anchorRef,
    selection.setSelectedIds,
    cache,
    busy,
    seqOf,
  ]);
  const selectedFrom = useCallback(
    (ids: ReadonlySet<string>) => {
      return [...ids]
        .flatMap((id) => {
          const message = messagesById.get(id)?.message ?? cache.get(id);
          return message ? [message] : [];
        })
        .sort((a, b) => {
          const aPosition = messagesById.get(a.id),
            bPosition = messagesById.get(b.id);
          if (aPosition && bPosition) return aPosition.index - bPosition.index;
          const aSeq = seqOf(a),
            bSeq = seqOf(b);
          if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
          return Date.parse(a.createdAt) - Date.parse(b.createdAt);
        });
    },
    [cache, messagesById, seqOf],
  );
  const selectedMessages = useMemo(
    () => selectedFrom(selection.selectedIds),
    [selectedFrom, selection.selectedIds],
  );
  const mergedGaps = useMemo(() => mergeSelectionGaps(gaps), [gaps]);
  const selectedCount = useMemo(
    () =>
      mergedGaps.reduce((count, gap) => count + gap.count, 0) +
      selectedMessages.filter((message) => {
        const seq = seqOf(message);
        return seq === null || !gapIndex.containsSequence(seq);
      }).length,
    [mergedGaps, selectedMessages, seqOf, gapIndex],
  );
  const current = (controller: AbortController) =>
    !controller.signal.aborted &&
    latest.current.owner === owner &&
    latest.current.cache === cache &&
    latest.current.active;
  const load = async (
    controller: AbortController,
    mode: 'local' | 'roaming',
    startSeq: string,
    endSeq: string,
  ) => {
    const received: Message[] = [];
    const receivedIds = new Set<string>();
    await runMessageLoadTask(
      mode === 'local' ? '加载范围消息' : '拉取漫游消息',
      async (report, signal) => {
        if (!conversation || !onLoad) throw new Error('当前会话没有可用的消息加载接口');
        await onLoad(
          { mode, conversation, startSeq, endSeq },
          (page) => {
            signal.throwIfAborted();
            if (!current(controller)) throw new Error('当前会话或数据源已变化');
            for (const message of page) {
              if (message.conversationId !== conversation.id) throw new Error('消息不属于所选会话');
              if (
                conversation.type === 'direct' &&
                message.sourceFormat === 'protocol' &&
                !message.ntSeqVerified
              )
                throw new Error('私聊漫游记录的 NT 序号尚未确认');
            }
            let added = 0;
            for (const message of page) {
              cache.set(message.id, message);
              if (!receivedIds.has(message.id)) {
                receivedIds.add(message.id);
                received.push(message);
                added++;
              }
            }
            report(added);
          },
          signal,
        );
      },
      controller.signal,
    );
    return received;
  };
  async function prepare(action: string): Promise<Message[] | null> {
    if (request.current || !conversation || !active) return null;
    const chosen = mergeSelectionGaps(
      [...selection.selectedIdsRef.current].flatMap((id) => {
        const gap = parseSelectionGap(id);
        return gap ? [gap] : [];
      }),
    );
    if (!chosen.length) return selectedFrom(selection.selectedIdsRef.current);
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const yes = await useDialog
        .getState()
        .confirm(
          '操作前拉取所选消息缺口？',
          `选区包含 ${chosen.length} 个合并区间，是否先合并拉取缺失消息，再${action}？`,
          { okLabel: `拉取并${action}`, cancelLabel: '保留选择' },
        );
      if (!yes || !current(controller)) return null;
      for (const gap of chosen) {
        const start = (BigInt(gap.previousSeq) + 1n).toString();
        const end = (BigInt(gap.currentSeq) - 1n).toString();
        // 跨窗口的候选区间可能只是尚未显示；先补本机已有消息，再合并拉取真正的空窗。
        await load(controller, 'local', start, end);
        if (!current(controller)) return null;
        const known = [...cache.values()].filter((message) => {
          const seq = seqOf(message);
          return seq !== null && seq > BigInt(gap.previousSeq) && seq < BigInt(gap.currentSeq);
        });
        for (const missing of selectionGapsBetween(gap.previousSeq, gap.currentSeq, known)) {
          await load(
            controller,
            'roaming',
            (BigInt(missing.previousSeq) + 1n).toString(),
            (BigInt(missing.currentSeq) - 1n).toString(),
          );
          if (!current(controller)) return null;
        }
      }
      const next = new Set(selection.selectedIdsRef.current);
      for (const id of [...next]) {
        const gap = parseSelectionGap(id);
        if (!gap) continue;
        const known = [...cache.values()].filter((message) => {
          const seq = seqOf(message);
          return seq !== null && seq > BigInt(gap.previousSeq) && seq < BigInt(gap.currentSeq);
        });
        const remaining = selectionGapsBetween(gap.previousSeq, gap.currentSeq, known);
        next.delete(id);
        for (const message of known) next.add(message.id);
        for (const missing of remaining) next.add(selectionGapId(missing));
      }
      selection.selectedIdsRef.current = next;
      selection.setSelectedIds(next);
      if ([...next].some((id) => parseSelectionGap(id))) {
        useToast.getState().push({ tone: 'warning', title: `所选缺口尚未补全，未执行${action}` });
        return null;
      }
      return selectedFrom(next);
    } catch {
      // 横幅保留具体错误；未成功的缺口与原选区不丢弃。
      return null;
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const onChange = (next: Set<string>) => {
    selection.setSelectedIds(next);
  };
  function selectRange(start: bigint, end: bigint, modifiers: SelectionModifiers) {
    const range = [...cache.values(), ...messages].filter((message) => {
      const seq = seqOf(message);
      return seq !== null && seq >= start && seq <= end;
    });
    const next = new Set(modifiers.ctrlKey || modifiers.metaKey ? selection.selectedIds : []);
    for (const message of range) next.add(message.id);
    for (const gap of selectionGapsBetween((start - 1n).toString(), (end + 1n).toString(), range))
      next.add(selectionGapId(gap));
    onChange(next);
  }
  const beforeSelect = (id: string, modifiers: SelectionModifiers) => {
    const item = itemsById.get(id);
    if (item?.message) cache.set(id, item.message);
    if (
      !modifiers.shiftKey &&
      item?.gap &&
      gapSelected(item.gap) &&
      !selection.selectedIds.has(id)
    ) {
      selection.setSelectedIds(
        (previous) =>
          new Set(
            [...previous].filter((key) => {
              const gap = parseSelectionGap(key);
              return (
                !gap ||
                !(
                  BigInt(gap.previousSeq) <= BigInt(item.gap.previousSeq) &&
                  BigInt(gap.currentSeq) >= BigInt(item.gap.currentSeq)
                )
              );
            }),
          ),
      );
      return true;
    }
    if (!modifiers.shiftKey || !selection.anchorRef.current) return false;
    const anchor =
      cache.get(selection.anchorRef.current) ?? itemsById.get(selection.anchorRef.current)?.message;
    const anchorGap = parseSelectionGap(selection.anchorRef.current);
    const targetSeq = item?.message
      ? seqOf(item.message)
      : item?.gap
        ? BigInt(item.gap.previousSeq)
        : null;
    const a =
      seqOf(anchor) ??
      (anchorGap
        ? targetSeq !== null && targetSeq >= BigInt(anchorGap.currentSeq)
          ? BigInt(anchorGap.previousSeq) + 1n
          : BigInt(anchorGap.currentSeq) - 1n
        : null);
    const b = item?.message
      ? seqOf(item.message)
      : item?.gap && a !== null
        ? a <= BigInt(item.gap.previousSeq)
          ? BigInt(item.gap.currentSeq) - 1n
          : BigInt(item.gap.previousSeq) + 1n
        : null;
    if (a === null || b === null) return false;
    if (!order.includes(selection.anchorRef.current)) {
      selectRange(a < b ? a : b, a > b ? a : b, modifiers);
      return true;
    }
    return false;
  };
  return {
    items,
    order,
    selectedMessages,
    selectedCount,
    gaps,
    gapSelected,
    busy,
    onChange,
    beforeSelect,
    prepare,
    cancel: () => request.current?.abort(),
  };
}
