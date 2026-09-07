/** 年度报告「群聊互动」(interactions) 数据契约 —— 一页关于热闹里的伸手与回声。 */

/** 被戳/被 @ 最多的人。名字已由 compute 解析为最终展示名。 */
export type InteractionsPerson = {
  /** NT uid；老记录可能只有 QQ 号。 */
  uid: string;
  /** QQ 号（十进制字符串），不一定有。 */
  uin: string;
  name: string;
  /** 这段互动主要发生的群。 */
  groupCode: string;
  groupName: string;
  count: number;
};

/** 某个群的一项聚合（被 @ 最多的群）。 */
export type InteractionsGroupTop = {
  groupCode: string;
  groupName: string;
  count: number;
};

/** 最长复读的落点。 */
export type InteractionsEcho = {
  groupCode: string;
  groupName: string;
  count: number;
  /** 被反复发的那句原文。 */
  text: string;
};

export type InteractionsPageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 我发起的戳一戳总次数（戳/捏/揉等 nudge 动作）。 */
  pokeTotal: number;
  /** 被我戳得最多的群友；没有可识别的目标时为 null。 */
  pokeTop: InteractionsPerson | null;
  /** 我发出的、指向具体成员的 @ 总次数（不含 @全体）。 */
  atTotal: number;
  /** 被我 @ 得最多的群友。 */
  atTop: InteractionsPerson | null;
  /** 别人直接 @ 到我的总次数。 */
  atMeTotal: number;
  /** 我被 @ 最多的群。 */
  atMeTop: InteractionsGroupTop | null;
  /** 我跟过多少次复读（长度 >3 且至少两个人的连续相同正文，含我的那一轮）。 */
  echoParticipated: number;
  /** 全群最长的复读。 */
  echoLongest: InteractionsEcho | null;
};
