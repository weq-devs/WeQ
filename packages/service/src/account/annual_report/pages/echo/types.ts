/**
 * 年度报告「复读」页数据契约 —— 一页关于「一句话被那么多人接住」。
 *
 * 场次与条数分开：`runs` 是「聊到齐声」的次数，`messages` 是这些齐声里被重复发出
 * 的条数合计。再各留一个「我参与过的最长一轮」与「全群最长的一轮」——前者是这一页
 * 的主体（不是人人一样的热闹），后者是同一件事在更大的群里的回声。
 */
import type { InteractionsEcho } from '../interaction-shared';

export type EchoPageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 达标复读回合总数（全群口径）。 */
  runs: number;
  /** 这些回合里被重复发出的消息合计条数。 */
  messages: number;
  /** 我跟上过的复读场数。 */
  participated: number;
  /** 我参与过的最长一轮复读；一次都没跟过时为 null。 */
  mineLongest: InteractionsEcho | null;
  /** 全群最长的一轮复读；没有达标回合时为 null。 */
  longest: InteractionsEcho | null;
};
