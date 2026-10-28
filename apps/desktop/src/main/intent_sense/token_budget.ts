/**
 * QWeQ 输入以历史上下文开头、待分析的消息结尾。
 * 当 token 总量超限时优先保留当前消息，不能让历史消息挤掉本次分类对象。
 * 输入来自同一个 tokenizer；首 token 与尾部消息 token 保持原始顺序。
 */
export function prioritizeCurrentMessageTokens(
  full: readonly number[],
  currentMessage: readonly number[],
  maxLength: number,
): number[] {
  if (!Number.isInteger(maxLength) || maxLength < 2) throw new Error('无效的模型 token 上限');
  if (full.length <= maxLength) return [...full];
  if (currentMessage.length >= maxLength) return currentMessage.slice(0, maxLength);
  // currentMessage 的首 token 是 tokenizer 已插入的起始特殊 token；
  // full 的前缀已经带了它，后缀只需拼入实际消息和结尾特殊 token。
  const suffixCount = Math.max(1, currentMessage.length - 1);
  return [...full.slice(0, maxLength - suffixCount), ...full.slice(-suffixCount)];
}
