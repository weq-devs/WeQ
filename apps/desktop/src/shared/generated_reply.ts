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
  let latest: GeneratedMessage | undefined;
  let preview = '';
  // 助手会原地补全消息并更新时间，存储顺序不一定是时间顺序。同一毫秒取靠后的记录。
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (latest && message.ts <= latest.ts) continue;
    if ('role' in message && message.status === 'running') continue;
    const summary = generatedMessageSummary(message);
    if (!summary) continue;
    latest = message;
    preview = summary;
  }
  if (!latest) return { lastMessageTime: 0, preview, previewMine: false, previewSender: undefined };
  const previewMine = ('role' in latest ? latest.role : latest.senderKind) === 'user';
  const previewSender =
    'senderId' in latest
      ? previewMine
        ? '我'
        : (senderName?.(latest.senderId) ?? '克隆体')
      : undefined;
  return { lastMessageTime: latest.ts / 1000, preview, previewMine, previewSender };
}
