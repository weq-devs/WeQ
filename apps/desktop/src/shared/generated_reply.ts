export interface GeneratedReply {
  kind: 'assistant' | 'persona' | 'group';
  conversationId: string;
  id: string;
  title: string;
  preview: string;
  messageId?: string;
  /** 实际入库的回复时间，与会话目录使用同一阅读位置。 */
  ts?: number;
}

export function generatedMessageSummary(message: {
  text: string;
  images?: readonly unknown[];
  steps?: readonly { kind: string }[];
}): string {
  const text = message.text
    .replace(/\[\[(sticker|voice):[^\]]+\]\]/g, (_, tag) => (tag === 'voice' ? '[语音]' : '[表情]'))
    .replace(/\s+/g, ' ')
    .trim();
  return (
    (message.images?.length ? `[图片]${text ? ' ' : ''}` : '') +
    (text || (message.steps?.some((step) => step.kind === 'artifact') ? '[附件]' : ''))
  ).slice(0, 160);
}

export function generatedDraftSummary(text = ''): string {
  return generatedMessageSummary({
    text: text
      .replace(/\[\[ai-image:[^\]]+\]\]/g, '[图片]')
      .replace(/\[\[chat:(?:emoji|face|mface|fav|gif):[^\]]+\]\]/g, '[表情]'),
  });
}

type GeneratedMessage = Parameters<typeof generatedMessageSummary>[0] & { ts: number } & (
    | { role: 'user' | 'assistant'; status?: string }
    | { senderKind: 'user' | 'persona'; senderId: string }
  );

export function latestGeneratedActivity(
  messages: readonly GeneratedMessage[],
  senderName?: (id: string) => string | undefined,
) {
  const lastMessageTime = Math.floor((messages.at(-1)?.ts ?? 0) / 1000);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if ('role' in message && message.status === 'running') continue;
    const preview = generatedMessageSummary(message);
    if (!preview) continue;
    const previewMine = ('role' in message ? message.role : message.senderKind) === 'user';
    const previewSender =
      'senderId' in message
        ? previewMine
          ? '我'
          : (senderName?.(message.senderId) ?? '克隆体')
        : undefined;
    return { lastMessageTime, preview, previewMine, previewSender };
  }
  return { lastMessageTime, preview: '', previewMine: false, previewSender: undefined };
}
