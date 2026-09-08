/** 年度报告「陪你走过 12 个月」(months) 数据契约 —— 一页关于按月更替的陪伴。 */

/** 月榜 / 年度聊伴里的一个人。`messages` 单位随所在语境（当月 / 全年）不同。 */
export type MonthFriendEntry = {
  peerUid: string;
  /** 用来拼头像的 QQ 号；本地资料缺失时为空串，渲染层画首字兜底。 */
  peerUin: string;
  /** 备注名 → 昵称 → 尾号兜底，compute 已经挑好。 */
  peerName: string;
  /** 双方合计消息条数。月榜里是当月条数，聊伴里是全年条数。 */
  messages: number;
};

/** 日历里的一个月。没有足够双向来往时只有分母，`top` 为 null。 */
export type MonthCompanionCell = {
  /** 1..12。 */
  month: number;
  /** 当月与「年度好友」的双向消息总条数（可统计性的分母）。 */
  monthMessages: number;
  /** 当月双方合计消息最多的好友；当月没有双向来往时为 null。 */
  top: MonthFriendEntry | null;
};

export type MonthsPageData = {
  /** 报告口径年份（自然年；本页在历史以来口径下不展示）。 */
  year: number;
  /**
   * 日历覆盖的月数：往年固定 12，今年画到当前月为止 —— 未来的月份还没有
   * 资格成为「走过的月份」。
   */
  monthCount: number;
  /** 双向来往过的好友总数（榜的分母）。 */
  friendCount: number;
  /** 这些好友和你往来的私聊总条数（双向合计）。 */
  totalMessages: number;
  /**
   * 「年度聊伴」：拿过当月第一最多的好友。没有任何月榜时（例如一整年都没有
   * 双向私聊）为 null，渲染层收成空态。
   */
  champion: MonthFriendEntry | null;
  /** 聊伴拿过几次当月第一。 */
  championMonths: number;
  /** 从 1 月到 monthCount 的逐月格子。 */
  months: MonthCompanionCell[];
};
