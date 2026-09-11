/**
 * 年度报告「@ 与被 @」(at) 数据契约 —— 一页关于「把名字放到人前」。
 *
 * 两个方向各留一组：我喊出去的名字，和喊我的名字。去重人数（`atPeople` /
 * `atMePeople`）是这一页的骨架 —— 它比总次数更能说明「你在多少个名字之间」，
 * 是页面画点阵图的依据。
 */
import type { InteractionsGroupTop, InteractionsPerson } from '../interaction-shared';

export type AtPageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 我发出的、指向具体成员的 @ 总次数（不含 @全体）。 */
  atTotal: number;
  /** 我 @ 过的不同人数 —— 喊过多少个不同的名字。 */
  atPeople: number;
  /** 被我 @ 得最多的群友。 */
  atTop: InteractionsPerson | null;
  /** 别人直接 @ 到我的总次数。 */
  atMeTotal: number;
  /** 在人群里喊过我的不同人数。 */
  atMePeople: number;
  /** 我被 @ 最多的群。 */
  atMeTop: InteractionsGroupTop | null;
};
