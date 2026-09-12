/**
 * 年度报告「戳一戳」页数据契约 —— 一页关于「最轻的搭话」。
 *
 * 两个方向对称：我戳出去多少次、最常戳到谁；别人戳我多少次、最常戳我的是谁。
 * 「被戳」是这次拆页时新增的方向 —— 它让这一页从「我伸了几次手」变成
 * 「有几次是别人先想起我」。
 */
import type { InteractionsPerson } from '../interaction-shared';

export type PokePageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 我发起的戳一戳（含戳/捏/揉等 nudge 动作）总次数。 */
  pokeTotal: number;
  /** 被我戳得最多的群友；没有可识别目标时为 null。 */
  pokeTop: InteractionsPerson | null;
  /** 别人戳到我的总次数。 */
  pokeMeTotal: number;
  /** 最常戳我的群友；没有可识别发起者时为 null。 */
  pokeMeTop: InteractionsPerson | null;
};
