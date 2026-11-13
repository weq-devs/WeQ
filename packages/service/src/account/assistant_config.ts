export type AssistantSendMode = 'interrupt' | 'boundary' | 'queue';

export const ASSISTANT_PARAMETER_DEFAULTS = {
  temperature: 0.3 as number | null,
  maxOutputTokens: null as number | null,
  maxRounds: 24 as number | null,
  toolTimeoutMs: 60_000 as number | null,
  taskTimeoutMs: 600_000 as number | null,
  historyMessages: 12,
  contextTokens: 32_768,
  compressionTrigger: 0.7,
  compressionTarget: 0.5,
  summaryTokens: 1500,
  sendMode: 'interrupt' as AssistantSendMode,
};

export type AssistantParameters = typeof ASSISTANT_PARAMETER_DEFAULTS;

export function validateAssistantParameters(value: Partial<AssistantParameters>): void {
  for (const [key, number] of Object.entries(value)) {
    if (!(key in ASSISTANT_PARAMETER_DEFAULTS) || key === 'sendMode') continue;
    if (
      number === null &&
      ['temperature', 'maxOutputTokens', 'maxRounds', 'toolTimeoutMs', 'taskTimeoutMs'].includes(
        key,
      )
    )
      continue;
    if (typeof number !== 'number' || !Number.isFinite(number))
      throw new Error(`${key} 必须是有效数值`);
    if (key === 'temperature') {
      if (number < 0 || number > 2) throw new Error('温度必须在 0 到 2 之间');
    } else if (key === 'compressionTrigger' || key === 'compressionTarget') {
      if (number <= 0 || number >= 1) throw new Error('压缩比例必须大于 0 且小于 1');
    } else if (!Number.isSafeInteger(number) || number < (key === 'historyMessages' ? 0 : 1)) {
      throw new Error(`${key} 必须是有效整数`);
    }
    if ((key === 'toolTimeoutMs' || key === 'taskTimeoutMs') && number > 2_147_483_647)
      throw new Error('时限超过系统计时范围，请选择不限制');
  }
  if (
    value.compressionTarget !== undefined &&
    value.compressionTrigger !== undefined &&
    value.compressionTarget >= value.compressionTrigger
  )
    throw new Error('压缩目标比例必须低于触发比例');
  if (
    value.summaryTokens !== undefined &&
    value.contextTokens !== undefined &&
    value.summaryTokens >= value.contextTokens
  )
    throw new Error('摘要长度必须小于上下文预算');
}
