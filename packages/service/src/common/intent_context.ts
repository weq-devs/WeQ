export const DEFAULT_ANALYSIS_CONTEXT_MESSAGES = 4;
// 旧推荐窗口共 24 条，扣除当前消息后保持 23 条上文。
export const DEFAULT_SUGGESTION_CONTEXT_MESSAGES = 23;
export const MAX_INTENT_CONTEXT_MESSAGES = 100;

export function isIntentContextCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_INTENT_CONTEXT_MESSAGES
  );
}
