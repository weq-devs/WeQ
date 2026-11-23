export const DEFAULT_CHAT_MESSAGE_PREWARM_MIB = 128;
export const MAX_CHAT_MESSAGE_PREWARM_MIB = 1024;

export function normalizeChatMessagePrewarmMiB(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_CHAT_MESSAGE_PREWARM_MIB, Math.max(0, Math.floor(value)))
    : DEFAULT_CHAT_MESSAGE_PREWARM_MIB;
}
