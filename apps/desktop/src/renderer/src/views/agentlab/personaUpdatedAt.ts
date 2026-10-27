import { formatConversationTimestamp } from '../../lib/conversationTime';

export function personaUpdatedAt(persona: { trainedAt?: number; updatedAt: number }): string {
  const timestamp = persona.trainedAt ?? persona.updatedAt;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '未知';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '未知';
  return formatConversationTimestamp(date.toISOString());
}
