/** 年度报告「我的主场」(home) 数据契约 —— 以自己发出的消息数为尺，选出最常开口的群。 */

/** 冠军群里的一条话题词及其出现次数（虚词 / 单字已在分词阶段剔除）。 */
export type HomeTopicWord = {
  word: string;
  count: number;
};

/** 这一年/这段历史里，我说过最多话的那个群。 */
export type HomeGroupTop = {
  /** 群号（群聊分区键，也用于兜底群名）。 */
  groupCode: string;
  groupName: string;
  /** 全群在口径内的消息总数（我 + 别人），给「你的发言占了多大分量」当分母。 */
  groupTotal: number;
  /** 口径内我自己在这个群发出的消息条数。 */
  sentCount: number;
  /** 群成员数；本地群资料缺失时为 0，渲染层自行隐藏。 */
  memberCount: number;
  /** 群等级数值；本地没有成员行/等级时为 0，渲染层自行隐藏。 */
  memberLevel: number;
  /** 群等级对应的名字（群主可自定义），没有配置时为空串。 */
  levelName: string;
  /** 群主给我设的自定义头衔；没有时为空串。 */
  customTitle: string;
  /** 我在群里的身份：群主 / 管理员 / 群员。 */
  role: 'owner' | 'admin' | 'member';
  /**
   * 这个群在口径内的高频话题词（全群正文词频，次数降序）。既是渲染层词云的
   * 素材，也是「话题总绕不开」那行字的来源；没有文字消息时为空数组。
   */
  topics: HomeTopicWord[];
};

export type HomePageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 口径内自己发过至少一条消息的群数（排行榜的分母）。 */
  activeGroupCount: number;
  /** 口径内自己在所有群发出的消息总数。 */
  groupSentTotal: number;
  /**
   * 说得最多的那个群。正常情况下始终非空；只有群资料缺失、连一条群消息都
   * 落不进 group_detail 时才会是 null —— 渲染层当作「没有足够的群聊资料」。
   */
  top: HomeGroupTop | null;
};
