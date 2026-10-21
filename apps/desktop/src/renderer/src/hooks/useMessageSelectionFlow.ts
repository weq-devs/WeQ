import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, Message } from '../im-template/template/types';
import type { useContentMultiSelect } from '../state/contentSelection';
import { useDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { runMessageLoadTask } from '../components/MessageLoadTask';
import { grayTipOf } from '../im-template/template/messageRow';
import {
  messageSelectionItems,
  parseSelectionGap,
  selectionGapId,
  selectionGapsBetween,
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
  const gaps = useMemo(
    () =>
      [...selection.selectedIds].flatMap((id) => {
        const gap = parseSelectionGap(id);
        return gap ? [gap] : [];
      }),
    [selection.selectedIds],
  );
  const gapSelected = (gap: SelectionGap) =>
    gaps.some(
      (selected) =>
        BigInt(selected.previousSeq) <= BigInt(gap.previousSeq) &&
        BigInt(selected.currentSeq) >= BigInt(gap.currentSeq),
    );
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
    for (const message of messages)
      if (selection.selectedIds.has(message.id) || selection.anchorRef.current === message.id)
        cache.set(message.id, message);
    if (!busy)
      for (const id of cache.keys())
        if (!selection.selectedIds.has(id) && selection.anchorRef.current !== id) cache.delete(id);
  }, [
    messages,
    selection.selectedIds,
    selection.anchorRef,
    selection.setSelectedIds,
    cache,
    busy,
    seqOf,
  ]);
  const selectedMessages = useMemo(() => {
    const available = new Map(cache);
    for (const message of messages) available.set(message.id, message);
    const positions = new Map(messages.map((message, index) => [message.id, index]));
    return [...selection.selectedIds]
      .flatMap((id) => (available.has(id) ? [available.get(id)!] : []))
      .sort((a, b) => {
        if (positions.has(a.id) && positions.has(b.id))
          return positions.get(a.id)! - positions.get(b.id)!;
        const aSeq = seqOf(a),
          bSeq = seqOf(b);
        if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });
  }, [cache, messages, selection.selectedIds, seqOf]);
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
  async function fetchGaps(chosen: SelectionGap[]) {
    if (!chosen.length || request.current || !conversation) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const yes = await useDialog
        .getState()
        .confirm(
          '拉取所选消息缺口？',
          `选中了 ${chosen.length} 处消息缺口，是否通过现有漫游接口拉取缺失消息？`,
          { okLabel: '拉取漫游', cancelLabel: '保留缺口选择' },
        );
      if (!yes || !current(controller)) return;
      for (const gap of chosen) {
        const received = await load(
          controller,
          'roaming',
          (BigInt(gap.previousSeq) + 1n).toString(),
          (BigInt(gap.currentSeq) - 1n).toString(),
        );
        if (!current(controller)) return;
        const known = [...cache.values(), ...received].filter((message) => {
          const seq = seqOf(message);
          return seq !== null && seq > BigInt(gap.previousSeq) && seq < BigInt(gap.currentSeq);
        });
        const remaining = selectionGapsBetween(gap.previousSeq, gap.currentSeq, known);
        selection.setSelectedIds((previous) => {
          const next = new Set(previous);
          next.delete(selectionGapId(gap));
          for (const message of known) next.add(message.id);
          for (const missing of remaining) next.add(selectionGapId(missing));
          return next;
        });
      }
    } catch {
      // 横幅保留具体错误；未成功的缺口与原选区不丢弃。
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const onChange = (next: Set<string>) => {
    selection.setSelectedIds(next);
    const chosen = [...next]
      .filter((id) => !selection.selectedIds.has(id))
      .flatMap((id) => {
        const gap = parseSelectionGap(id);
        return gap ? [gap] : [];
      });
    if (chosen.length) void fetchGaps(chosen);
  };
  async function loadRange(start: bigint, end: bigint, modifiers: SelectionModifiers) {
    if (request.current || !conversation) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    let next: Set<string> | null = null;
    try {
      const yes = await useDialog
        .getState()
        .confirm(
          '加载未显示的消息区间？',
          '起止消息之间包含尚未加载的区间。加载本地消息后再完成范围选择，消息缺口会另行确认是否拉取漫游。',
          { okLabel: '加载并选择', cancelLabel: '保留原选区' },
        );
      if (!yes || !current(controller)) return;
      await load(controller, 'local', start.toString(), end.toString());
      if (!current(controller)) return;
      const range = [...cache.values(), ...messages].filter((message) => {
        const seq = seqOf(message);
        return seq !== null && seq >= start && seq <= end;
      });
      next = new Set(modifiers.ctrlKey || modifiers.metaKey ? selection.selectedIds : []);
      for (const message of range) next.add(message.id);
      for (const gap of selectionGapsBetween((start - 1n).toString(), (end + 1n).toString(), range))
        next.add(selectionGapId(gap));
    } catch {
      // 范围加载失败或取消不替换原选区，右下角保留处理结果。
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
    if (next && current(controller)) onChange(next);
  }
  const beforeSelect = (id: string, modifiers: SelectionModifiers) => {
    const item = items.find((item) => item.id === id);
    if (item?.message) cache.set(id, item.message);
    if (item?.gap && gapSelected(item.gap) && !selection.selectedIds.has(id)) {
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
      cache.get(selection.anchorRef.current) ??
      messages.find((message) => message.id === selection.anchorRef.current);
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
    if (a === null || b === null) {
      if (!order.includes(selection.anchorRef.current)) {
        useToast
          .getState()
          .push({ tone: 'warning', title: '起止消息没有可信序号，无法加载跨窗口范围' });
        return true;
      }
      return false;
    }
    const anchorIndex = order.indexOf(selection.anchorRef.current),
      targetIndex = order.indexOf(id);
    const crossesGap =
      anchorIndex >= 0 &&
      items
        .slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
        .some((item) => item.gap);
    if (anchorIndex < 0 || crossesGap) {
      void loadRange(a < b ? a : b, a > b ? a : b, modifiers);
      return true;
    }
    return false;
  };
  return {
    items,
    order,
    selectedMessages,
    gaps,
    gapSelected,
    busy,
    onChange,
    beforeSelect,
    cancel: () => request.current?.abort(),
  };
}
