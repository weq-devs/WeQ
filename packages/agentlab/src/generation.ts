export const CLONE_GENERATION = {
  historyMessages: { default: 8, min: 0, max: 100 },
  pairExamples: { default: 5, min: 0, max: 30 },
  memoryItems: { default: 4, min: 0, max: 30 },
  expressionItems: { default: 4, min: 0, max: 20 },
  maxOutputTokens: { default: 0, min: 0, max: 32768 },
} as const;
export type CloneGenerationKey = keyof typeof CLONE_GENERATION;
export const CLONE_GENERATION_KEYS = Object.keys(CLONE_GENERATION) as CloneGenerationKey[];
export type AgentLabGenerationConfig = Record<CloneGenerationKey, number> & {
  temperature: number | null;
  reasoningEffort?: string;
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
  const effort = typeof input?.reasoningEffort === 'string' ? input.reasoningEffort.trim() : '';
  return {
    ...values,
    ...(effort && effort.length <= 64 && effort !== 'off' ? { reasoningEffort: effort } : {}),
    temperature:
      typeof input?.temperature === 'number' &&
      Number.isFinite(input.temperature) &&
      input.temperature >= 0 &&
      input.temperature <= 2
        ? input.temperature
        : null,
  };
}
