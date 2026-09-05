/** 年度总览（overview）数据契约 —— 开篇第一页，速度优先。 */
export type OverviewPageData = {
  year: number;
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
