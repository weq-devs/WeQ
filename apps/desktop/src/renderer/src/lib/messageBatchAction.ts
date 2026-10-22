import type { Message } from '../im-template/template/types';
import { canDiscardFailedMessage } from './localOutgoing';
import { isLocalOutgoingMessage } from './messageSelection';

export type MessageBatchAction = 'export' | 'analysis' | 'delete' | 'recall';

/** 操作依据实际来源，不因发送者是自己而排除消息。 */
export function messageBatchBlockReason(
  message: Message,
  action: MessageBatchAction,
): string | null {
  if (action === 'recall') return '尚未核对当前会话的撤回权限和消息定位';
  if (message.source === 'roaming') {
    if (
      (action === 'export' || action === 'delete') &&
      /^roaming:(?:(?:native|protocol):)?[1-9]\d*:-?\d+$/.test(message.id)
    )
      return null;
    return action === 'delete'
      ? '漫游缓存消息身份无效，无法定位可删除记录'
      : '漫游缓存尚未入库，当前操作只处理本地记录';
  }
  if (!isLocalOutgoingMessage(message)) return null;
  if (action === 'delete' && canDiscardFailedMessage(message)) return null;
  return message.optimistic === 'sending'
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
