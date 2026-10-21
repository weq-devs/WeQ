export const CLONE_GENERATION = {
  historyMessages: { label: '对话历史上限（条）', default: 8, min: 0, max: 100 },
  pairExamples: { label: '参考问答数量', default: 5, min: 0, max: 30 },
  memoryItems: { label: '召回记忆数量', default: 4, min: 0, max: 30 },
  expressionItems: { label: '表达风格数量上限', default: 4, min: 0, max: 20 },
  maxOutputTokens: { label: '输出 Token 上限（0 为模型默认）', default: 0, min: 0, max: 32768 },
} as const;
export type CloneGenerationKey = keyof typeof CLONE_GENERATION;
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
