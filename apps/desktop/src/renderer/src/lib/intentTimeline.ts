import { isSelfIdentity } from './selfIdentity';

export interface IntentTimelineMessage {
  id: string;
  senderId: string;
  body?: string;
  qqElements?: readonly { type?: string; data?: Record<string, unknown> }[];
  optimistic?: string;
  optimisticRejected?: boolean;
  recalled?: boolean;
  recall?: unknown;
  deleted?: boolean;
  deletedKind?: unknown;
}

/** 与服务端 text／face 分析范围一致，不把引用或媒体占位当成正文。 */
export function messageHasIntentText(
  message: Pick<IntentTimelineMessage, 'body' | 'qqElements'>,
): boolean {
  if (!Array.isArray(message.qqElements)) return Boolean(message.body?.trim());
  return message.qqElements.some((element) => {
    const value =
      element.type === 'text'
        ? element.data?.textContent
        : element.type === 'face'
          ? element.data?.faceText
          : undefined;
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/** 分析目标可来自自己；回复目标只取最新有效消息且必须是对方。 */
export function intentTimelineTargets<T extends IntentTimelineMessage>(
  messages: readonly T[],
  self: ReadonlySet<string>,
  isSystem: (message: T) => boolean,
): { latestMessageId: string | null; latestPeerMsgId: string | null } {
  let latest: T | undefined;
  let latestMessageId: string | null = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      !message ||
      message.recalled ||
      message.recall ||
      message.deleted ||
      message.deletedKind ||
      isSystem(message)
    )
      continue;
    latest ??= message;
    if (!message.optimistic && !message.optimisticRejected && messageHasIntentText(message)) {
      latestMessageId = message.id;
      break;
    }
  }
  const latestPeerMsgId =
    latest &&
    self.size > 0 &&
    !latest.optimistic &&
    !latest.optimisticRejected &&
    !isSelfIdentity(self, latest.senderId)
      ? latest.id
      : null;
  return { latestMessageId, latestPeerMsgId };
}
