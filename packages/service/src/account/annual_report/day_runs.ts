/**
 * 「连续天数」这件事，报告里不止一页要算 —— 私聊火花页要算自己的最长连续发言，
 * 好友榜页要算每个人的最长火花。两处的判据必须完全一致（同一个本地自然日索引、
 * 同一个连续定义），所以放在这里共享，而不是各写一份。
 *
 * 纯函数、零依赖，不进 barrel：这是页面之间的内部工具，不是数据契约的一部分。
 */

/** 本地自然日索引（unix 天数）—— 判断连续用的稳定整数。 */
export function dayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(new Date(y!, m! - 1, d!).getTime() / 86_400_000);
}

/** 升序日索引里的最长连续段长度。空数组为 0。 */
export function longestRun(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]! + 1) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }
  return longest;
}
