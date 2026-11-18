export interface AgentLabGenerationConfig {
  useTrainingSamples?: boolean;
  useLongTermMemory?: boolean;
  reasoningEffort?: string;
}

export const CLONE_REFERENCE_COUNTS = { pairs: 5, expressions: 4, memories: 4 };

export function normalizeCloneGeneration(input?: AgentLabGenerationConfig) {
  const legacy = input as
    | (AgentLabGenerationConfig & {
        pairExamples?: number;
        expressionItems?: number;
        memoryItems?: number;
      })
    | undefined;
  const effort = typeof input?.reasoningEffort === 'string' ? input.reasoningEffort.trim() : '';
  return {
    useTrainingSamples:
      input?.useTrainingSamples ?? !(legacy?.pairExamples === 0 && legacy?.expressionItems === 0),
    useLongTermMemory: input?.useLongTermMemory ?? legacy?.memoryItems !== 0,
    ...(effort && effort.length <= 64 && effort !== 'off' ? { reasoningEffort: effort } : {}),
  };
}
