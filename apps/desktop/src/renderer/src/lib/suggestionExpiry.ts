/** 推荐间隔只保留最大的两个非零单位；满一分钟后不再展示秒。 */
export function formatSuggestionAge(elapsedMs: number): string {
  let seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const parts: string[] = [];
  for (const [size, label] of [
    [365 * 86400, '年'],
    [86400, '天'],
    [3600, '小时'],
    [60, '分钟'],
  ] as const) {
    const count = Math.floor(seconds / size);
    seconds %= size;
    if (count) parts.push(`${count}${label}`);
    if (parts.length === 2) break;
  }
  return parts.join('');
}
