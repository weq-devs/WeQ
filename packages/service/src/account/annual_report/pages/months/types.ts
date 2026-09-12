/** 年度报告「陪你走过 12 个月」(months) 数据契约 —— 一页关于按月更替的陪伴。 */

/** 月榜 / 年度聊伴里的一个人。`messages` 单位随所在语境（当月 / 全年）不同。 */
export type MonthFriendEntry = {
  peerUid: string;
  /** 用来拼头像的 QQ 号；本地资料缺失时为空串，渲染层画首字兜底。 */
  peerUin: string;
  /** 备注名 → 昵称 → 尾号兜底，compute 已经挑好。 */
  peerName: string;
  /**
   * 双方合计消息条数。月榜里是当月条数；聊伴里是「全年」条数 —— 当年还在进行
   * 且用去年补足格铺满月历时，则是**近 12 个月**的条数。
   */
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
  /** 去年同月补足的格子。true 时渲染层降饱和并注明「去年」。 */
  carried?: boolean;
};

export type MonthsPageData = {
  /** 报告口径年份（自然年；本页在历史以来口径下不展示）。 */
  year: number;
  /**
   * 当年已经走过的月数：满年固定 12；当年画到当前月为止 —— 未来的月份还没有
   * 资格成为「走过的月份」。不足的部分由 `carryoverMonths` 用去年的尾部月份补足，
   * 拼起来正好 12 个月（例：9 月报告 = 去年 10-12 月 + 今年 1-9 月）。
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
  /**
   * 聊伴在**可见的 12 格**里拿过几次当月第一。当年不足 12 个月时包含
   * `carryoverMonths`（去年补足格）里的胜场。
   */
  championMonths: number;
  /** 从 1 月到 monthCount 的逐月格子。 */
  months: MonthCompanionCell[];
  /**
   * 滚动补足格：当年月份不足 12 时，取去年 `monthCount+1..12` 的月榜补足日历。
   * 数组升序、只含需要补的月份，渲染层把它们排在 `months` 前面（例：9 月报告
   * 时数组为去年 10/11/12 月），与 `months` 拼起来正好 12 个月；满年时为空数组。
   */
  carryoverMonths: CarryoverMonth[];
};

/** 「滚动补足」格 —— 用去年对应月份的月榜补足当年的空缺月份。 */
export type CarryoverMonth = { month: number; top: MonthCompanionCell['top'] };
