/** 年度报告「还没加好友的同路人」(mate) 数据契约 —— 跨群重合度最高的非好友。 */

/** 和某人重逢过的一个群。`weight` 用来解释为什么这几个群最能说明「同频」。 */
export type MateSharedGroup = {
  groupCode: string;
  groupName: string;
  /** 群成员数（本地群资料口径）。 */
  memberCount: number;
  /**
   * 这个群的「独特性权重」：(0, 1]。对其它群 h，重合度 =
   * |members(g) ∩ members(h)| / |members(g)|（g 被 h 完全装下时为 1，
   * 完全不相交为 0）；W(g) = 1 / (1 + Σ_{h≠g} 重合度)。
   * 十个一模一样的群每个只分到 1/10 —— 复制群不算十个兴趣，只算一个。
   */
  weight: number;
};

/** 榜上一位「还没加好友的同路人」。 */
export type MateCandidate = {
  uid: string;
  /** 用来拼头像的 QQ 号；老记录可能拿不到。 */
  uin: string;
  /** 最终展示名（优先全局昵称，其次群名片，最后尾号兜底）。 */
  name: string;
  /** 加权重合指数 = 此人所在共同群的独特性权重之和，只用于排序。 */
  score: number;
  /** 和你共同在的群数（≥2 才配得上「重逢」）。 */
  sharedCount: number;
  /** 共同群，按独特性权重降序。 */
  groups: MateSharedGroup[];
};

export type MatePageData = {
  /** 报告口径年份（`ALL_TIME_YEAR` 0 = 历史以来）。 */
  year: number;
  /** 参与了重合度计算、并且本地还有在群成员资料的群数。 */
  groupCount: number;
  /** 这组群里扫到的未加好友群友总数（去重，含只碰过一面的人）。 */
  personCount: number;
  /**
   * 加权重合最高的非好友。要求至少和你在两个群里重逢，否则整页没有故事可讲
   * （只同群一次的群友到处都是，谈不上「生态位重合」）。
   */
  top: MateCandidate | null;
  /** 冠军之外再推荐几位（最多 4），组件小一号排在其后。 */
  more: MateCandidate[];
};
