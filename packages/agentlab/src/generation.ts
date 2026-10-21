export const CLONE_GENERATION = {
  historyMessages: { label: '对话历史上限（条）', default: 8, min: 0, max: 100 },
  pairExamples: { label: '参考问答数量', default: 5, min: 0, max: 30 },
  memoryItems: { label: '召回记忆数量', default: 4, min: 0, max: 30 },
  expressionItems: { label: '表达风格数量上限', default: 4, min: 0, max: 20 },
  maxOutputTokens: { label: '输出 Token 上限', default: 0, min: 0, max: 32768 },
} as const;
export type CloneGenerationKey = keyof typeof CLONE_GENERATION;
export const CLONE_GENERATION_HELP: Record<CloneGenerationKey, string> = {
  historyMessages: '附带的历史消息数；0 表示不附带历史，不会变成传入全部历史。',
  pairExamples: '从已训练问答中召回的参考数量；0 表示不附带。',
  memoryItems: '本轮附带的记忆数量；0 表示不附带，不会删除已有记忆。',
  expressionItems: '表达风格库的引用上限；0 表示不附带此类表达。',
  maxOutputTokens: '0 表示采用模型默认上限。',
};
export const CLONE_GENERATION_KEYS = Object.keys(CLONE_GENERATION) as CloneGenerationKey[];
export type AgentLabGenerationConfig = Record<CloneGenerationKey, number> & {
  temperature: number | null;
};

export function normalizeCloneGeneration(
  input?: Partial<AgentLabGenerationConfig>,
): AgentLabGenerationConfig {
  const values = Object.fromEntries(
    CLONE_GENERATION_KEYS.map((key) => {
      const rule = CLONE_GENERATION[key];
      const value = input?.[key];
      return [
        key,
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= rule.min &&
        value <= rule.max
          ? value
          : rule.default,
      ];
    }),
  ) as Record<CloneGenerationKey, number>;
  return {
    ...values,
    temperature:
      typeof input?.temperature === 'number' &&
      Number.isFinite(input.temperature) &&
      input.temperature >= 0 &&
      input.temperature <= 2
        ? input.temperature
        : null,
  };
}
