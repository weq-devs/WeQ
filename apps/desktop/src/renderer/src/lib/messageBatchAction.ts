import type { Message } from '../im-template/template/types';
import { canDiscardFailedMessage } from './localOutgoing';
import { isLocalOutgoingMessage } from './messageSelection';
import { grayTipOf } from '../im-template/template/messageRow.shared';
import { messageHasIntentText } from './intentTimeline';
import { forwardMessageBlockReason } from './sequentialForward';

export const messageBatchLabels = {
  export: '导出',
  analysis: '分析',
  delete: '删除',
  recall: '撤回',
  restore: '恢复',
  intent: '分析消息意图',
  merge: '合并转发',
  forward: '逐条转发',
  material: '添加到素材库',
  text: '复制为纯文本',
  rich: '复制为富文本',
  json: '复制为 JSON',
  image: '复制为图片',
} as const;
export type MessageBatchAction = keyof typeof messageBatchLabels;

export type MessageBatchDecision = {
  label: string;
  include?: boolean;
  detail?: string;
};

export type MessageReviewContext = {
  deleted?: (message: Message) => boolean;
  analyzed?: ReadonlySet<string>;
  assess?: (message: Message) => MessageBatchDecision | null | undefined;
};

export function reviewMessageBatch(
  messages: readonly Message[],
  action: MessageBatchAction,
  context: MessageReviewContext = {},
) {
  const groups = new Map<
    string,
    Omit<MessageBatchDecision, 'detail'> & {
      key: string;
      messages: Message[];
      details: Map<string, string>;
    }
  >();
  const rows = messages.map((message) => {
    const assessed = context.assess?.(message);
    const decision = assessed === undefined ? reviewMessage(message, action, context) : assessed;
    if (!decision) return { message, group: null };
    const key = JSON.stringify([decision.label, decision.include ?? null]);
    let group = groups.get(key);
    if (!group) {
      group = {
        label: decision.label,
        include: decision.include,
        key,
        messages: [],
        details: new Map(),
      };
      groups.set(key, group);
    }
    group.messages.push(message);
    if (decision.detail) group.details.set(message.id, decision.detail);
    return { message, group };
  });
  return { rows, groups: [...groups.values()] };
}

function reviewMessage(
  message: Message,
  action: MessageBatchAction,
  { deleted, analyzed }: MessageReviewContext,
): MessageBatchDecision | undefined {
  const gray = grayTipOf(message);
  const restoredByWeq = message.deletedKind === 'weq' || deleted?.(message);
  const removed = message.deletedKind || restoredByWeq;
  const failed = message.optimistic === 'failed';
  const pending = message.optimistic === 'queued' || message.optimistic === 'sending';
  const status = gray
    ? '系统提示'
    : message.recall
      ? '已撤回消息'
      : removed
        ? '已删除消息'
        : failed
          ? '发送失败的消息'
          : pending
            ? '正在发送的消息'
            : message.optimisticRejected
              ? '发送结果未确认的消息'
              : message.optimistic === 'sent'
                ? '已发送、等待同步的消息'
                : undefined;
  const blocked = (detail?: string, label = status ?? '内容不可用的消息') => ({ label, detail });
  if (action === 'restore')
    return restoredByWeq
      ? { label: '可恢复的已删除消息', include: true }
      : blocked(undefined, removed ? '由 QQ 删除的记录' : (status ?? '未删除的消息'));
  if (action === 'recall') {
    if (gray || message.recall || removed) return blocked();
    return blocked(messageBatchBlockReason(message, action) ?? undefined);
  }
  if (action === 'intent') {
    if (gray || isLocalOutgoingMessage(message) || !messageHasIntentText(message))
      return blocked(undefined, status ?? '没有可分析内容的消息');
    if (analyzed?.has(message.id))
      return { label: '已有分析结果', include: false, detail: '开启后重新分析' };
  }
  if (action === 'forward') {
    const reason = forwardMessageBlockReason(message);
    if (reason) return blocked(reason, failed ? '原稿或附件不可用' : (status ?? reason));
    if (!status && message.qqElements?.some(({ type }) => type === 'reply'))
      return { label: '引用消息', include: true, detail: '仅转发正文' };
  }
  if (action === 'merge' && gray) return blocked();
  if (action === 'export' || action === 'analysis' || action === 'delete') {
    if (action === 'delete' && message.deletedKind === 'qq' && !restoredByWeq)
      return blocked(undefined, '由 QQ 删除的记录');
    const reason = messageBatchBlockReason(message, action);
    if (reason) return blocked(reason, status ?? reason);
    if (action === 'delete' && failed)
      return { label: '发送失败的消息', include: true, detail: '仅从本机移除' };
  }
  if (!status) return undefined;
  return {
    label: status,
    include: action === 'image' || action === 'delete' || (!removed && !message.recall),
  };
}

/** 操作依据实际来源，不因发送者是自己而排除消息。 */
export function messageBatchBlockReason(
  message: Message,
  action: MessageBatchAction,
): string | null {
  if (message.generatedPending) return '生成内容尚未取得持久消息身份';
  if (action === 'recall') return '尚未核对当前会话的撤回权限和消息定位';
  if (message.source === 'roaming') {
    if (
      (action === 'export' || action === 'delete' || action === 'analysis') &&
      /^roaming:(?:(?:native|protocol):)?[1-9]\d*:-?\d+$/.test(message.id)
    )
      return null;
    return '漫游缓存消息身份无效，无法定位记录';
  }
  if (!isLocalOutgoingMessage(message)) return null;
  if (action === 'delete' && canDiscardFailedMessage(message)) return null;
  return message.optimistic === 'sending' || message.optimistic === 'queued'
    ? '消息仍在发送中'
    : message.optimistic === 'sent' && !message.optimisticRejected
      ? '已发送，正在等待正式记录同步入库'
      : '这条发送占位没有可操作的正式记录';
}

export function partitionMessageBatch(
  messages: readonly Message[],
  action: MessageBatchAction,
  reasonFor?: (message: Message) => string | null,
) {
  const supported: Message[] = [];
  const unsupported: Array<{ message: Message; reason: string }> = [];
  for (const message of messages) {
    const reason = reasonFor ? reasonFor(message) : messageBatchBlockReason(message, action);
    if (reason) unsupported.push({ message, reason });
    else supported.push(message);
  }
  return { supported, unsupported };
}
