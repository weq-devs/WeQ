/** 好友榜（friends）数据契约 —— 只统计 c2c，且只统计双向来往过的人。 */

/** 榜上的一位好友。`value` 的单位由所在榜决定（天 / 条）。 */
export type FriendRankEntry = {
  peerUid: string;
  /** 用来拼头像的 QQ 号；profile 缓存里没这个人时为空串，渲染层画首字兜底。 */
  peerUin: string;
  /** 备注名 → 昵称 → 尾号兜底，服务端已经挑好。 */
  peerName: string;
  /** 名次上的数值：火花榜 = 天数，消息榜 = 双方合计条数。 */
  value: number;
  /** 这个人和你双方合计的私聊条数 —— 火花榜上作为副信息展示。 */
  messages: number;
};

export type FriendsPageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 最长火花榜前三（双方连日都有消息的最长连续天数），降序。可能不足三位甚至为空。 */
  sparkTop: FriendRankEntry[];
  /** 私聊消息榜前八（双方合计条数），降序。只要发过私聊就至少有一位。 */
  messageTop: FriendRankEntry[];
  /** 双向来往过的好友总数 —— 榜的分母。 */
  friendCount: number;
  /** 这些好友和你往来的私聊总条数（双向合计）。 */
  totalMessages: number;
};
