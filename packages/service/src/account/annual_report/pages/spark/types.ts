/** 私聊火花（spark）数据契约 —— 只统计 c2c，不含群聊 / 数据线 / 服务号。 */

/** 某一天里一个私聊会话的「主角」记忆。 */
export type SparkTopDay = {
  /** `YYYY-MM-DD`，按本地时区。 */
  date: string;
  year: number;
  month: number;
  day: number;
  peerUid: string;
  peerUin: string;
  /** 备注名 → 昵称 → 尾号兜底，服务端已经挑好。 */
  peerName: string;
  /** 双方合计条数（那一天的该会话内）。 */
  total: number;
  /** 自己发出的条数。 */
  mine: number;
  /** 那一天你们聊得最多的那一个高频词（空 = 没有可展示的词）。 */
  words: string[];
};

/** 最长火花 —— 连续双方都有发言的最长天数。 */
export type SparkBest = {
  days: number;
  peerUid: string;
  peerUin: string;
  peerName: string;
};

/** 绿墙里一个有发言的本地日期。零发言的格子不上发，渲染层补空位。 */
export type SparkWallDay = {
  year: number;
  month: number;
  day: number;
  count: number;
};

export type SparkPageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 自己发过私聊的本地年份（升序）—— 历史以来的绿墙可切换范围。 */
  wallYears: number[];
  /** 默认展示的绿墙年份（自然年口径 = 该年；历史以来 = 最近一个有发言的年份）。 */
  wallYear: number;
  /**
   * 当年的「近 12 个月」滚动窗口：{ fromYear, fromMonth, toYear, toMonth }。
   * 一年的前几个月看报告时，绿墙往前接到去年同月之后，始终覆盖近 12 个月；
   * null = 完整自然年墙（往年报告 / 当年 12 月）。
   */
  wallWindow: {
    fromYear: number;
    fromMonth: number;
    toYear: number;
    toMonth: number;
  } | null;
  /** 每个发言日的自己发出条数（私聊），按 (year, date) 升序。 */
  wallDays: SparkWallDay[];
  /** 单日聊得最多的那个会话。只要有 c2c 发言就一定有。 */
  topDay: SparkTopDay | null;
  /** 自己一共发过多少条私聊。 */
  sentTotal: number;
  /** 自己发过消息的天数。 */
  activeDays: number;
  /** 自己连续发过私聊消息的最长天数。 */
  longestSelfRun: number;
  /** 双方连续都有消息的最长纪录（QQ 火花）；没有互聊对象时为 null。 */
  spark: SparkBest | null;
};
