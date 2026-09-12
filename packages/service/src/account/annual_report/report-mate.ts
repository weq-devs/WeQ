/**
 * 「还没加好友的同路人」页的排序说明文案。
 *
 * 屏幕版 / HTML / PDF / 长图四端都展示这份说明，所以把「为什么是 TA」这种容易
 * 越写越飘的文字收成纯函数：只要数据契约不变，四端就不会再次各说各话。
 *
 * 口径一句话：榜单不按「共同群最多」排，而按群经过独立性加权后的「同频指数」。
 * 十个互相复制的群只算一个圈子；被大群完全套住的小群也会被摊薄。
 *
 * 文案刻意只留一句、最多两句：这一页的主题是「同一个人总在不同的群里出现」，
 * 数字和名字才是主角，解释只负责把「为什么排这里」交代清楚就收住。
 */

/** 长图/HTML 里参与文案的最小候选形状（与 MateCandidate 字段对齐）。 */
export type MateCopyCandidate = {
  name?: string;
  sharedCount?: number;
  score?: number;
  groups?: Array<{ groupName?: string; memberCount?: number; weight?: number }>;
};

/** 页尾收束语 —— 四端共用一句，避免各端各写一版。 */
export const MATE_MOOD = '世界很大，圈子很小——下次再遇见，不妨说句「你好」。';

/** 「第 N 位」之类的榜位措辞。 */
export function mateRankLabel(rank: number): string {
  if (rank <= 0) return '榜首';
  const labels = ['二', '三', '四', '五', '六', '七', '八', '九'];
  return labels[rank - 1] ? `第 ${labels[rank - 1]!} 位` : `第 ${rank + 1} 位`;
}

/** 一句榜单主语：榜首/第 N 位 + 名字。 */
export function mateHeadline(candidate: MateCopyCandidate, rank: number): string {
  const name = String(candidate.name ?? 'TA');
  if (rank <= 0) return `${name}，和你圈子重叠最深的人`;
  return `${name}，${mateRankLabel(rank)}的同路人`;
}

/**
 * 具体为什么是这一位：一句话，落到这个人自己的数字上。榜首那句顺带把
 * 「数量最多 ≠ 排名最高」讲明白（指数会给更独立的圈子更高权重）。
 */
export function mateAnalysisText(
  candidate: MateCopyCandidate,
  rank: number,
  all: MateCopyCandidate[],
): string {
  const shared = Number(candidate.sharedCount ?? 0);
  const score = Number(candidate.score ?? 0);
  const maxShared = Math.max(1, ...all.map((item) => Number(item.sharedCount ?? 0)));
  const sharedMost = shared >= maxShared;
  const scoreText = Number.isFinite(score)
    ? `${score >= 100 ? Math.round(score) : score.toFixed(score >= 10 ? 1 : 2)}`
    : '0';

  if (rank <= 0) {
    return sharedMost
      ? `共同在 ${shared} 个群里碰过面，同频指数 ${scoreText}——数量和圈子的独立性都是第一。`
      : `共同在 ${shared} 个群里碰过面，同频指数 ${scoreText}——TA 的圈子更独立，重合质量最高。`;
  }
  if (sharedMost) {
    return `共同群其实最多（${shared} 个），但圈子彼此重合，加权后指数 ${scoreText}。`;
  }
  return `共同 ${shared} 个群，同频指数 ${scoreText}——圈子越独立，分量越重。`;
}
