/** 年度总览（overview）数据契约 —— 开篇第一页，速度优先。 */
export type OverviewPageData = {
  /** 统计口径。`ALL_TIME_YEAR`（0）= 「历史以来」。 */
  year: number;
  /**
   * 口径覆盖的天数 —— 日均的分母，服务端算好下发。自然年是整年（当年到今天），
   * 「历史以来」是最早一条消息到今天。渲染层与三种导出产物共用同一个值。
   */
  spanDays: number;
  /**
   * 最早一条消息的 sendTime（unix 秒）。只有「历史以来」口径会带上，用于
   * 「从 xxxx 年 x 月起」这类文案；自然年不需要，为 null。
   */
  firstMessageTime: number | null;
  /** 发出消息总数（私聊发出 + 群聊发出）。 */
  totalSent: number;
  /** 收到消息总数（私聊收到 + 群聊收到）。 */
  totalReceived: number;
  /** 私聊发出的条数。 */
  c2cSent: number;
  /** 群聊发出的条数。 */
  groupSent: number;
  /** 私聊收到的条数。 */
  c2cReceived: number;
  /** 群聊收到的条数。 */
  groupReceived: number;
};
