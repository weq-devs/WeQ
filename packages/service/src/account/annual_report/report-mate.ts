/**
 * 「还没加好友的同路人」页的排序说明文案。
 *
 * 屏幕版 / HTML / PDF / 长图四端都展示这份说明，所以把「为什么是 TA」这种容易
 * 越写越飘的文字收成纯函数：只要数据契约不变，四端就不会再次各说各话。
 *
 * 口径一句话：榜单不按「共同群最多」排，而按群经过独立性加权后的「同频指数」。
 * 十个互相复制的群只算一个圈子；被大群完全套住的小群也会被摊薄。
 */

/** 长图/HTML 里参与文案的最小候选形状（与 MateCandidate 字段对齐）。 */
export type MateCopyCandidate = {
  name?: string;
  sharedCount?: number;
  score?: number;
  groups?: Array<{ groupName?: string; memberCount?: number; weight?: number }>;
};

/** 「第 N 位」之类的榜位措辞。 */
export function mateRankLabel(rank: number): string {
  if (rank <= 0) return '榜首';
  const labels = ['二', '三', '四', '五', '六', '七', '八', '九'];
  return labels[rank - 1] ? `第 ${labels[rank - 1]!} 位` : `第 ${rank + 1} 位`;
}

/** 一句榜单主语：榜首/第 N 位 + 名字。 */
export function mateHeadline(candidate: MateCopyCandidate, rank: number): string {
  const name = String(candidate.name ?? 'TA');
  if (rank <= 0) return `${name}，这一年和你圈子重叠最深的人`;
  return `${name}，${mateRankLabel(rank)}的同路人`;
}

/**
 * 具体为什么是这一位。把「数量最多 ≠ 排名最高」讲明白，并落到这个人自己的
 * 数字上 —— 不写死成一句口号，导出/展示端只需排两行文字。
 */
export function mateAnalysisText(
  candidate: MateCopyCandidate,
  rank: number,
  all: MateCopyCandidate[],
): string {
  const shared = Number(candidate.sharedCount ?? 0);
  const score = Number(candidate.score ?? 0);
  const maxShared = Math.max(1, ...all.map((item) => Number(item.sharedCount ?? 0)));
  const name = String(candidate.name ?? 'TA');
  const sharedMost = shared >= maxShared;
  const scoreText = Number.isFinite(score)
    ? `${score >= 100 ? Math.round(score) : score.toFixed(score >= 10 ? 1 : 2)}`
    : '0';

  if (rank <= 0) {
    // 榜首：即使不是共同群最多，也把「为什么」讲明白。
    return sharedMost
      ? `${name} 的共同群数正好也最多（${shared} 个），加权重合指数 ${scoreText} ——
         这一位同时赢在「数量」和「圈子的独立性」上。算法并不只数共同群：十个互相
         复制的群只算一个圈子，TA 的群彼此越错开，指数才越高。`
      : `${name} 并不是共同群最多的那一位，却是「同频指数」最高的：指数 ${scoreText} 不只数
         共同群个数，还会给更独立、不互相重复的圈子更高权重 —— TA 的 ${shared} 个共同群里，
         真正不一样的圈子更多，重合质量也更高。`;
  }

  if (sharedMost) {
    return `单看共同群数，${name} 其实是候选里最多的（${shared} 个）；之所以排在 ${mateRankLabel(
      rank,
    )}，是因为这些群彼此有一些高度重合/复制关系，按独立性加权后指数 ${scoreText} 不如榜首。`;
  }
  return `${name} 和你共同在 ${shared} 个群，按群独立性加权的同频指数是 ${scoreText} ——
     指数不只是数「重逢了几次」，重复的圈子会被摊薄，越独立、越不一样的群分量越重。`;
}
