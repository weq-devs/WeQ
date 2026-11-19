import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AiImageOutcome } from '@weq/agentlab';
import type { CloneConversationEvent } from '@weq/service';
import { useToast } from '../../components/Toast.shared';
import { ACCOUNT_STATE_CHANGED, accountBinding } from '../../lib/clientPreferences';
import { client, trpc } from '../../trpc/client';
import { IS_WEB } from '../../lib/target.shared';
import { newOutgoingRequestId } from '../../hooks/useOutgoingReceipts';
import type { AiImageAssetRef } from '../../lib/aiImageDraft';

export type LiveCloneDelivery = {
  optimistic?: 'sending' | 'failed';
  outgoingToHost?: boolean;
  optimisticError?: string;
};

const subscribeBinding = (listener: () => void) => {
  window.addEventListener(ACCOUNT_STATE_CHANGED, listener);
  return () => window.removeEventListener(ACCOUNT_STATE_CHANGED, listener);
};

export function useLiveCloneConversation<
  T extends { id?: string; ts: number; imageOutcomes?: AiImageOutcome[] },
>(
  kind: 'persona' | 'group',
  id: string,
  rows: readonly T[] | undefined,
  active: boolean,
  messageFrom: (event: CloneConversationEvent) => T | undefined,
) {
  const binding = useSyncExternalStore(subscribeBinding, accountBinding);
  const utils = trpc.useUtils();
  const [typing, setTyping] = useState(false);
  const [changes, setChanges] = useState(new Map<string, T & LiveCloneDelivery>());
  const confirmed = useRef(new Map<string, boolean>());
  const reported = useRef(new Set<string>());
  const refresh = (reset = false) => {
    if (kind === 'persona') {
      if (reset) utils.account.getAgentLabConversation.setData({ personaId: id }, []);
      void utils.account.getAgentLabConversation.invalidate({ personaId: id });
      void utils.account.listAgentLabPersonas.invalidate();
    } else {
      if (reset) utils.account.getAgentLabGroupConversation.setData({ groupId: id }, []);
      void utils.account.getAgentLabGroupConversation.invalidate({ groupId: id });
      void utils.account.listAgentLabGroups.invalidate();
    }
  };
  const record = (event: CloneConversationEvent) => {
    if (event.kind === 'typing') {
      setTyping(event.typing);
      return;
    }
    if (event.kind === 'cleared') {
      setChanges(new Map());
      reported.current.clear();
      refresh(true);
      return;
    }
    if (event.kind === 'settled') {
      refresh();
      return;
    }
    if (event.kind === 'error') {
      useToast.getState().push({ tone: 'error', title: '克隆回复失败', detail: event.message });
      return;
    }
    const message = messageFrom(event);
    if (!message?.id) return;
    if (confirmed.current.has(message.id)) confirmed.current.set(message.id, true);
    setChanges((previous) => new Map(previous).set(message.id!, message));
    if (reported.current.has(message.id)) return;
    reported.current.add(message.id);
    if (kind === 'persona') void utils.account.listAgentLabPersonas.invalidate();
    else void utils.account.listAgentLabGroups.invalidate();
  };
  const live = useRef({ record, refresh });
  live.current = { record, refresh };

  useEffect(() => {
    reported.current.clear();
    if (!active || !binding) return;
    const subscription = client.account.onCloneConversation.subscribe(
      { ...binding, kind, id },
      {
        onStarted: () => live.current.refresh(),
        onData: (event) => {
          if (accountBinding() === binding) live.current.record(event);
        },
        onError: () => setTyping(false),
      },
    );
    return () => subscription.unsubscribe();
  }, [active, binding, kind, id]);

  const history = useMemo(() => {
    const byId = new Map((rows ?? []).map((row, index) => [row.id ?? `legacy:${index}`, row]));
    for (const [id, row] of changes) {
      const persisted = byId.get(id);
      if (persisted && (row.optimistic || !row.imageOutcomes || persisted.imageOutcomes)) continue;
      byId.set(id, row);
    }
    return [...byId.values()].sort((a, b) => a.ts - b.ts) as Array<T & LiveCloneDelivery>;
  }, [rows, changes]);

  async function send(
    text: string,
    images: AiImageAssetRef[],
    makeLocal: (id: string, ts: number) => T,
    mentions?: string[],
  ) {
    if (!binding) throw new Error('账号尚未就绪');
    const requestId = newOutgoingRequestId();
    confirmed.current.set(requestId, false);
    const local: T & LiveCloneDelivery = {
      ...makeLocal(requestId, Math.max(Date.now(), (history.at(-1)?.ts ?? 0) + 1)),
      optimistic: 'sending',
      outgoingToHost: IS_WEB,
    };
    setChanges((previous) => new Map(previous).set(requestId, local));
    try {
      const event = await client.account.submitCloneMessage.mutate({
        ...binding,
        kind,
        id,
        requestId,
        text,
        images,
        mentions,
      });
      if (accountBinding() === binding) {
        // 实时事件可能已经给同一条消息补上了图片解读，迟到的提交回执不覆盖它。
        const message = messageFrom(event);
        if (message)
          setChanges((previous) =>
            previous.get(requestId)?.optimistic === 'sending'
              ? new Map(previous).set(requestId, message)
              : previous,
          );
        refresh();
      }
    } catch (error) {
      if (accountBinding() !== binding || confirmed.current.get(requestId)) return;
      const detail = error instanceof Error ? error.message : String(error);
      setChanges((previous) =>
        previous.get(requestId)?.optimistic === 'sending'
          ? new Map(previous).set(requestId, {
              ...local,
              optimistic: 'failed',
              outgoingToHost: false,
              optimisticError: detail,
            })
          : previous,
      );
      refresh();
      useToast.getState().push({ tone: 'error', title: '发送失败', detail });
      throw error;
    } finally {
      confirmed.current.delete(requestId);
    }
  }

  return { history, send, typing: active && Boolean(binding) && typing, ready: Boolean(binding) };
}
