export type AssistantSendMode = 'interrupt' | 'boundary' | 'queue';

export const DEFAULT_ASSISTANT_SEND_MODE: AssistantSendMode = 'boundary';

/** 导入旧备份时仍识别这些字段；正式配置与运行时不再使用。 */
export const RETIRED_ASSISTANT_PARAMETERS = [
  'temperature',
  'maxOutputTokens',
  'maxRounds',
  'toolTimeoutMs',
  'taskTimeoutMs',
  'historyMessages',
  'contextTokens',
  'compressionTrigger',
  'compressionTarget',
  'summaryTokens',
] as const;
