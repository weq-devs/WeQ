/** 谁先开口（openers）数据契约 —— 统计单位是「场聊天/开场」，不是消息条数。 */

/** 三位被写进这页的朋友之一。值都是开场次数与比例。 */
export type OpenerEntry = {
  peerUid: string;
  /** 用来拼头像的 QQ 号；profile 缓存里没这个人时为空串，渲染层画首字兜底。 */
  peerUin: string;
  /** 备注名 → 昵称 → 尾号兜底，服务端已经挑好。 */
  peerName: string;
  /** 这一年/这段时间里，你在这段关系里先开口的次数。 */
  selfStarts: number;
  /** 这一年/这段时间里，对方先开口的次数。 */
  peerStarts: number;
  /** 双方开场次数合计。 */
  totalStarts: number;
  /** 你开场的比例，0~1（保留四位小数）。 */
  selfRatio: number;
};

export type OpenersPageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 被统计到的私聊对象人数（至少开过一场）。 */
  peerCount: number;
  /** 全部开场次数。 */
  totalStarts: number;
  /** 其中你先开口的次数。 */
  selfStarts: number;
  /** 其中对方先开口的次数。 */
  peerStarts: number;
  /** 你先开口的比例，0~1。 */
  selfRatio: number;
  /** 你发起占比最高的那位好友（补充显示次数）。 */
  mostMine: OpenerEntry | null;
  /** 发起率最接近五五开的那位好友。 */
  balanced: OpenerEntry | null;
  /** TA 发起占比最高的那位好友（补充显示次数）。 */
  mostPeer: OpenerEntry | null;
};
