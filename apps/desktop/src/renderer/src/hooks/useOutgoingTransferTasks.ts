import { useEffect, useRef } from 'react';
import type { BackgroundTask } from '../../../shared/background_task';
import { useToast } from '../components/Toast.shared';
import { notificationSource, openNotificationSource } from '../lib/notificationNavigation.shared';
import { outgoingSequenceRejected } from '../lib/outgoingAcknowledgment';
import {
  taskNotificationForeground,
  taskNotificationKey,
} from '../lib/taskNotificationPresentation';
import { localBackgroundTasks } from '../state/backgroundTasks';
import type { OptimisticMessage } from '../views/workspace/types';

type Binding = { expectedAccountUin: string; expectedAccountConfigId: string };

export function outgoingMediaSend(
  elements: readonly unknown[],
  conversation: { name: string; type: string },
  scope: string,
): OptimisticMessage['mediaSend'] {
  const media = (
    elements as readonly {
      type?: string;
      data?: { fileName?: unknown; subType?: unknown; isAiVoice?: unknown };
    }[]
  ).filter((element) => {
    if (element?.type === 'pic') return Number(element.data?.subType) !== 1;
    if (element?.type === 'ptt') return !element.data?.isAiVoice;
    return ['file', 'video', 'bubbleVideo'].includes(element?.type ?? '');
  });
  if (!media.length) return undefined;
  const name = media[0]?.data?.fileName;
  return {
    scope,
    subject:
      media.length > 1
        ? `${media.length} 项附件`
        : (typeof name === 'string' && name.trim().split(/[\\/]/).at(-1)) || '1 项附件',
    conversationName: conversation.name,
    conversationKind: conversation.type === 'group' ? 'group' : 'c2c',
  };
}

export function useOutgoingTransferTasks(
  messages: readonly OptimisticMessage[],
  binding: Binding | null | undefined,
  activeConversationId?: string,
) {
  const projected = useRef(new Map<string, BackgroundTask>());
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  useEffect(() => {
    const records = projected.current;
    return () => {
      for (const id of records.keys()) localBackgroundTasks.discardProjection(id);
      records.clear();
    };
  }, [uin, configId]);
  useEffect(() => {
    if (!uin || !configId) return;
    const scope = JSON.stringify([uin, configId]);
    const records = projected.current;
    const present = new Set<string>();
    for (const message of messages) {
      const { mediaSend } = message;
      if (mediaSend?.scope !== scope) continue;
      const uncertain = message.state === 'sent' && outgoingSequenceRejected(message);
      if (message.state === 'sent' && !uncertain) continue;
      const id = `send:${message.id}`;
      present.add(id);
      const previous = records.get(id);
      const failed = message.state === 'failed' || uncertain;
      const status = failed ? 'failed' : 'running';
      const statusLabel = uncertain
        ? '可能未送达'
        : message.state === 'failed'
          ? '发送失败'
          : message.state === 'queued'
            ? '排队中'
            : undefined;
      const inConversation = activeConversationId === message.convId;
      const transfer = failed
        ? undefined
        : { id: message.transferId, toHost: !message.hostReceived, inConversation };
      if (
        previous?.status === status &&
        previous.statusLabel === statusLabel &&
        previous.note === message.error &&
        previous.outgoingTransfer?.id === transfer?.id &&
        previous.outgoingTransfer?.toHost === transfer?.toHost &&
        previous.outgoingTransfer?.inConversation === transfer?.inConversation
      )
        continue;
      const messageTarget = {
        conversationKind: mediaSend.conversationKind,
        conv: message.convId,
        msgId: message.id,
      };
      const source = notificationSource(
        { kind: 'conversation', ...messageTarget, dismissTaskPanel: true },
        '查看消息',
        { expectedAccountUin: uin, expectedAccountConfigId: configId },
      );
      const now = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1);
      const task: BackgroundTask = {
        id,
        name: '发送附件',
        display: {
          action: '发送附件',
          subject: mediaSend.subject,
          context: mediaSend.conversationName,
          fileName: true,
        },
        kind: 'send-media',
        scope: { uin, configId },
        status,
        statusLabel,
        messageTarget,
        needsConfirmation: uncertain,
        note: message.error,
        outgoingTransfer: transfer,
        actions: [],
        startedAt: message.at,
        updatedAt: now,
        finishedAt: failed ? now : undefined,
      };
      records.set(id, task);
      localBackgroundTasks.project(task, [
        { id: 'open-message', label: source.label, run: () => openNotificationSource(source) },
      ]);
      const key = taskNotificationKey(scope, `background:window:${id}`);
      if (!failed) useToast.getState().resolve(key);
      else if (
        previous?.statusLabel !== statusLabel &&
        (!inConversation || !taskNotificationForeground())
      ) {
        useToast.getState().push({
          key,
          taskId: `background:window:${id}`,
          event: 'taskFailure',
          tone: uncertain ? 'warning' : 'error',
          title: `${statusLabel}：${mediaSend.subject}`,
          detail: uncertain ? '请核对原消息是否已送达。' : message.error,
          source,
        });
      }
    }
    for (const id of records.keys()) {
      if (present.has(id)) continue;
      records.delete(id);
      localBackgroundTasks.discardProjection(id);
      useToast.getState().resolve(taskNotificationKey(scope, `background:window:${id}`));
    }
  }, [messages, uin, configId, activeConversationId]);
}
