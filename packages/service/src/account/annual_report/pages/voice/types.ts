/** 年度报告「我的话」（voice）数据契约 —— 统计自己发出的口头禅与表情。 */

/** 一个统计单位：词 / 短语，及其出现的次数。 */
export type VoiceWord = {
  word: string;
  count: number;
};

/** 最喜欢的系统表情（QQ 自带 face 元素）。 */
export type VoiceFaceFavorite = {
  /** QQ NT 的 faceId（如 264 = 捂脸）；渲染层按它拼 weq-asset://emoji/<id>/…。 */
  faceId: number;
  /** 干净的表情名（捂脸 / 微笑…），供导出版与 aria 使用。 */
  name: string;
  /** 这一年/这段历史里，自己发出的该表情元素次数。 */
  count: number;
};

/**
 * 最喜欢的自定义表情（pic element, subType = CUSTOM / imgType = EMOJI）。
 *
 * 自定义表情在数据库里没有「表情包 id」，只有一张图（md5 / fileName / fileToken）。
 * 为让渲染层能把它从本地媒体缓存里取出来，保留最后一次出现的那条消息的寻址信息：
 * 发件时间（转成毫秒）、文件名、md5、fileToken 与原始 URL。
 */
export type VoicePicFavorite = {
  /** 稳定去重键（md5 或文件名主干，大写十六进制）。 */
  key: string;
  /** 最后一次出现那条消息的媒体文件名。 */
  fileName: string;
  md5: string;
  fileToken: string;
  originalUrl: string;
  /** 最后一次出现那条消息的发送时间（unix **毫秒**，weq-media://pic 用）。 */
  sendTimeMs: number;
  subType: number;
  imgType: number;
  /** 图片原始宽高（0 = 未知），渲染层用来限制占位大小。 */
  width: number;
  height: number;
  /** 出现次数。 */
  count: number;
};

export type VoicePageData = {
  /** 报告口径年份。`ALL_TIME_YEAR`（0）= 历史以来。 */
  year: number;
  /** 口径内自己发出的、带正文的消息条数（私聊 + 群聊）。 */
  sentTotal: number;
  /** 其中至少含一段 text 元素的消息条数。 */
  textMessages: number;
  /** 口头禅 —— 正文分词后最常出现的那个词；没有可用的词时为 null。 */
  word: VoiceWord | null;
  /** 词云素材：出现次数降序，给背景词云用（含口头禅本身）。 */
  cloud: VoiceWord[];
  /**
   * 最常用的系统表情排行（次数降序）。保留前几名而不是只留第一，
   * 是为了让页面能画出「最大是第一名、旁边跟着老朋友」的表情带。
   * 一段历史里没发过系统表情时为空数组。
   */
  faces: VoiceFaceFavorite[];
  /** 自己发出的系统表情元素总次数（非去重）。 */
  faceTotal: number;
  /** 最喜欢的自定义表情；一段历史里没发过自定义表情时为 null。 */
  pic: VoicePicFavorite | null;
  /** 自己发出的自定义表情（pic）总次数。 */
  picTotal: number;
};
