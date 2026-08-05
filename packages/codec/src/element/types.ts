

export type {
  TextElement,
  AtElement,
  PicElement,
  FileElement,
  PttElement,
  VideoElement,
  FaceElement,
  ReplyElement,
  GrayTipRevokeElement,
  GrayTipPokeElement,
  GrayTipGroupElement,
  GrayTipXmlElement,
  GrayTipFileRecvElement,
  GrayTipTempSessionElement,
  WalletElement,
  ArkElement,
  MfaceElement,
  MarkdownElement,
  MultiMsgElement,
  InlineKeyboardButton,
  InlineKeyboardRow,
  InlineKeyboardElement,
  CallElement,
  OnlineFileElement,
  OnlineFolderElement,
  EmojiBounceElement,
  QqDynamicElement,
  ShareLocationElement,
  UnknownElement,
  Element,
} from './spec';

/**
 * Element type discriminator (wire tag 45002).
 *
 * The full list comes from QQ NT's own `NTMsgElementType` enum. Values marked
 * "未观测" have never appeared in our sample databases — they are declared
 * anyway so a future encounter resolves to a named constant instead of an
 * anonymous number, and so nobody has to re-derive the list.
 */
export enum ElementType {
  /** 未知 / 占位. 未观测. */
  UNKNOWN = 0,
  TEXT = 1,
  PIC = 2,
  FILE = 3,
  PTT = 4,
  VIDEO = 5,
  FACE = 6,
  REPLY = 7,
  /** 小灰条：撤回提示、拍一拍、入群通知等，语义由 subType 决定（见 GrayTipSubType）。 */
  GRAY_TIP = 8,
  WALLET = 9,
  ARK = 10,
  MFACE = 11,
  /** 直播礼物. 未观测. */
  LIVE_GIFT = 12,
  /** 结构化长消息. 未观测. */
  STRUCT_LONG_MSG = 13,
  MARKDOWN = 14,
  /** Giphy 动图. 未观测. */
  GIPHY = 15,
  /** 合并转发（QQ 内部名 MULTIFORWARD）。 */
  MULTI_MSG = 16,
  /**
   * 内联键盘（机器人按钮）。与一个 MARKDOWN 元素成对出现：markdown 是卡片正文，
   * 键盘是卡片底部的按钮组。行在 48751，按钮在行内的 48753。
   */
  INLINE_KEYBOARD = 17,
  /** 文字内嵌礼物. 未观测. */
  IN_TEXT_GIFT = 18,
  /** 日程 / 日历. 未观测. */
  CALENDAR = 19,
  /** YOLO 小游戏结果. 未观测. */
  YOLO_GAME_RESULT = 20,
  /** 音视频通话记录（QQ 内部名 AVRECORD）。 */
  CALL = 21,
  /** 动态 Feed. 未观测. */
  FEED = 22,
  /** 在线文件（QQ 内部名 TOFURECORD）。 */
  ONLINE_FILE = 23,
  /** 气泡（QQ 内部名 ACEBUBBLE）. 未观测. */
  ACE_BUBBLE = 24,
  /** 活动卡片. 未观测. */
  ACTIVITY = 25,
  /** QQ 动态分享卡（QQ 内部名 TOFU）。 */
  QQ_DYNAMIC = 26,
  /** 表情弹射（QQ 内部名 FACEBUBBLE）。 */
  EMOJI_BOUNCE = 27,
  /** 位置共享。文案在 tag 52152（如「发起了位置共享」）。 */
  SHARE_LOCATION = 28,
  /** 任务置顶消息. 未观测. */
  TASK_TOP_MSG = 29,
  /** 在线文件夹。 */
  ONLINE_FOLDER = 30,
  /** 推荐消息. 未观测. */
  RECOMMENDED_MSG = 43,
  /** 操作栏. 未观测. */
  ACTION_BAR = 44,
}

/**
 * TEXT element sub-type (wire tag 45003) — QQ's link-safety classification,
 * not a text style. Derived from the full-table scan: subType>0 only ever
 * appears on messages whose content is (or contains) a URL.
 */
export enum TextSubType {
  /** 普通文本，不含链接。 */
  PLAIN = 0,
  /**
   * 外部链接。Carries `urlVerifyFlag` (45112) — 12/24/248 bytes of
   * safety-check payload QQ attaches after scanning the domain.
   */
  EXTERNAL_LINK = 1,
  /**
   * 可信链接（腾讯系域名：docs.qq.com / mp.weixin.qq.com …）。No 45112 —
   * QQ skips the safety check for its own domains.
   */
  TRUSTED_LINK = 2,
}

/**
 * PIC element sub-type (wire tag 45003). Names come from QQ NT's own
 * `PicSubType` enum; only 0/1 are common in practice, but 2/3/4/7 all appear
 * in the wild and 10..14 show up too (beyond the vendor enum — those stay
 * unnamed, since renderings would be needed to identify them).
 */
export enum PicSubType {
  /** 普通图片。 */
  NORMAL = 0,
  /** 自定义表情（收藏的表情包）。 */
  CUSTOM = 1,
  /** 热图。 */
  HOT = 2,
  /** 斗图。 */
  DIPPER_CHART = 3,
  /** 智能图。 */
  SMART = 4,
  /** 空间图。 未观测. */
  SPACE = 5,
  /** 未知（厂商枚举里就叫 KUNKNOW）。 未观测. */
  UNKNOW = 6,
  /** 关联图。 */
  RELATED = 7,
}

export enum PicType {
  NORMAL = 1000,
  EMOJI = 2000,
  ORIGINAL = 1001,
}

/**
 * GRAY_TIP element sub-type (wire tag 45003) — decides what the gray tip
 * actually says. Names come from QQ NT's `NTGrayTipElementSubTypeV2` enum.
 * Only REVOKE/GROUP_TIP/FILE/XML_MSG/AIO_OP/JSON have been seen so far; the
 * rest are declared so an unseen value resolves to a name rather than a
 * bare number.
 */
export enum GrayTipSubType {
  /** 未知 / 占位. 未观测. */
  UNKNOWN = 0,
  /** 撤回提示（「XX 撤回了一条消息」）。 */
  REVOKE = 1,
  /** 群公告. 未观测. */
  PROCLAMATION = 2,
  /** 表情回应. 未观测. */
  EMOJI_REPLY = 3,
  /** 群通知：入群 / 退群 / 禁言 / 改名片等。 */
  GROUP_TIP = 4,
  /** 好友相关提示. 未观测. */
  BUDDY = 5,
  /** 动态 Feed 提示. 未观测. */
  FEED = 6,
  /** 设为精华消息. 未观测. */
  ESSENCE = 7,
  /** 群通知（系统下发）. 未观测. */
  GROUP_NOTIFY = 8,
  /** 好友通知（系统下发）. 未观测. */
  BUDDY_NOTIFY = 9,
  /**
   * 文件传输完成灰条。Carries FILE metadata (45402 fileName ×2, 45405 size,
   * 45407 md5, 45503 fileToken) rather than any gray-tip field — QQ writes it
   * as a separate row alongside the real FILE message. It marks a finished
   * transfer in either direction (a file received from the peer, or one we
   * uploaded successfully). Row-level msgType is 40011=5/40012=1 (system tip)
   * or 40011=1/40012=2.
   */
  FILE = 10,
  /** 频道消息 Feed. 未观测. */
  FEED_CHANNEL_MSG = 11,
  /**
   * XML 灰条：`grayTipXmlContent` 里是一段 `<gtip>`，语义完全由内容决定 ——
   * 入群邀请、「XX 回应了你的消息」、各类互动提示都走这一个 subType。别按
   * subType 猜文案，要解析 XML。
   */
  XML_MSG = 12,
  /** 本地消息（仅本端可见）. 未观测. */
  LOCAL_MSG = 13,
  /** 拉黑相关. 未观测. */
  BLOCK = 14,
  /**
   * AIO 操作类灰条 —— 临时会话提示。QQ 渲染为「该用户通过 xxx 群聊向你发起
   * 临时会话」，其中群号取自 tag 47502（已验证是群号，不是对方 QQ）。
   * 恒为会话首条消息（seq=1）且行级 40020 为空。
   */
  AIO_OP = 15,
  /** 钱包相关. 未观测. */
  WALLET = 16,
  /** JSON 灰条：拍一拍、互动标识（畅聊之火 / 初泛涟漪）等。 */
  JSON = 17,
}

/**
 * 群通知灰条（GrayTipSubType.GROUP_TIP）的具体事件类型（wire tag 48501）。
 * 名字取自 QQ NT 的 `TipGroupElementType` 枚举。本地库里出现过 1/2/3/5/8，
 * 其余声明出来是为了将来遇到时有名字可对，而不是一个裸数字。
 */
export enum TipGroupElementType {
  /** 未知 / 占位. 未观测. */
  KUNKNOWN = 0,
  /** 成员入群：user1 是新成员，user2 是邀请人（无邀请人时 QQ 只写 user1）。 */
  KMEMBERADD = 1,
  /** 群已解散。 */
  KDISBANDED = 2,
  /** 成员被移出群聊：user1Nick 是操作者昵称，user2Uid 是被移出者。 */
  KQUITTE = 3,
  /** 群创建成功. 未观测. */
  KCREATED = 4,
  /** 群名被修改：user1 是操作者，groupTipGroupName 是新群名。 */
  KGROUPNAMEMODIFIED = 5,
  /** 成员被拉黑 / 加入黑名单. 未观测. */
  KBLOCK = 6,
  /** 成员被移出黑名单. 未观测. */
  KUNBLOCK = 7,
  /** 禁言：详情在 muteInfo（操作者 / 被禁言者 / 时长，时长 0 表示解除）。 */
  KSHUTUP = 8,
  /** 群因违规被回收. 未观测. */
  KBERECYCLED = 9,
  /** 群被解散或被回收. 未观测. */
  KDISBANDORBERECYCLED = 10,
}

/**
 * CALL 元素的 subType（= wire tag 48151 `answerType`，也等于消息行的 40012 列）。
 *
 * 私聊与群聊是两套编号：私聊一条消息就是一整通电话的最终状态（接通 / 未接 /
 * 拒绝 / 取消），群聊则拆成「发起」与「已结束」两条独立消息，中间状态不落库。
 *
 * 2025 年前后 QQ 重构过通话模块，旧客户端与新客户端对同一语义会写不同的编号
 * （例如视频接通旧版写 5、新版写 2），所以两个都得留着。旧记录还能靠
 * `callFlag48156 === 0`、`duration` 存的是 unix 秒级时间戳（新版是毫秒时长）、
 * 以及 callSummary 带「[语音通话] 」前缀来辨认。
 */
export enum CallSubType {
  /** 群聊：某人发起了语音通话（callMethod=VOICE，发送者即发起人）。 */
  GROUP_VOICE_STARTED = 1,
  VIDEO_ACCEPTED = 2,
  VIDEO_REJECTED_BY_US = 3,
  /** 视频接通（旧版客户端编号，语义同 VIDEO_ACCEPTED）。 */
  VIDEO_ACCEPTED_LEGACY = 5,
  VIDEO_REJECTED_BY_PEER = 6,
  VOICE_ACCEPTED = 7,
  VOICE_REJECTED_BY_US = 8,
  /** 我方拨出、对方一直没接（旧版客户端）。 */
  VOICE_PEER_NO_ANSWER = 9,
  /** 我方拨出后自己取消 —「已取消，点击重拨」。 */
  VOICE_CANCELED_BY_US = 10,
  VOICE_REJECTED_BY_PEER = 11,
  VIDEO_HANDLED_OTHER_DEVICE = 12,
  VOICE_HANDLED_OTHER_DEVICE = 13,
  /** 群聊：语音通话已结束（callMethod=0，无发送者）。 */
  GROUP_VOICE_ENDED = 16,
  SCREEN_SHARE_ACCEPTED = 19,
  SCREEN_SHARE_REJECTED = 22,
  /** 群聊：视频通话已结束（callMethod=0，无发送者）。 */
  GROUP_VIDEO_ENDED = 25,
  /** 群聊：某人发起了视频通话（callMethod=VIDEO，发送者即发起人）。 */
  GROUP_VIDEO_STARTED = 26,
  REMOTE_ASSIST_ACCEPTED = 33,
  REMOTE_ASSIST_FAILED = 34,
}

/**
 * CALL 元素的通话方式（wire tag 48154 `callMethod`）。
 *
 * 群聊的「通话已结束」消息写 0：那条消息不属于任何发起人（40020 为空），QQ 也
 * 不再区分是语音还是视频 —— 具体类型只能从 subType（16 / 25）看出来。
 */
export enum CallType {
  /** 群通话结束提示，无方式字段。 */
  GROUP_ENDED = 0,
  VOICE = 1,
  VIDEO = 2,
  SCREEN_SHARE = 3,
  REMOTE_ASSIST = 5,
}

/**
 * 红包 / 转账类型 — value of WALLET wire tag 48412 (`walletRedbagType`).
 *
 * TRANSFER/NORMAL/PASSWORD/VOICE 来自早期 RE；LUCKY(3) 与 DESIGNATED(8) 为实测
 * 确认（对比同群拼手气红包与专属红包的 msgBody）。DESIGNATED 红包会额外带 wire
 * tag 48420 (`walletDesignatedUin`) 指定唯一可领取的群友 uin。
 */
export enum RedbagType {
  /** 转账。 */
  TRANSFER = 1,
  /** 普通红包（等额）。 */
  NORMAL = 2,
  /** 拼手气红包。 */
  LUCKY = 3,
  /** 口令红包。 */
  PASSWORD = 6,
  /** 专属红包（指定领取人，见 walletDesignatedUin/48420）。 */
  DESIGNATED = 8,
  /** 语音红包。 */
  VOICE = 15,
}

export enum FaceSubType {
  QQ_BUILTIN_OLD = 1,
  QQ_BUILTIN_NEW = 2,
  SUPER_EMOJI = 3,
  UNKNOWN_4 = 4,
  INTERACTIVE = 5,
}

export enum ActionType {
  SYSTEM = 1,
}

// ─────────────────────────────────────────────────────────────────────────
// Downstream-parsing helper shapes (NOT part of the wire — these describe
// the structure of JSON/XML payloads carried INSIDE certain wire string
// fields like arkData, tipJson, grayTipXmlContent, xmlContent).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shape of the JSON document stored in wire field 47901 for ARK elements.
 */
export interface ArkPayload {
  app: string;
  desc: string;
  meta: Record<string, Record<string, unknown>>;
  prompt: string;
  sourceName?: string;
  ver?: string;
  view: string;
  config?: ArkConfig;
}

export interface ArkConfig {
  /** Unix seconds. */
  ctime: number;
  /** Card signature token. */
  token: string;
}

/**
 * Shape of the XML document stored in wire field 48602 for MULTI_MSG.
 */
export interface MultiMsgXmlPayload {
  serviceID: string;
  templateID: string;
  action: string;
  brief: string;
  m_resid: string;
  m_fileName: string;
  tSum: string;
  flag: string;
  item?: {
    layout: string;
    titles: Array<{ color: string; size: string; text: string }>;
    summary?: { color: string; text: string };
  };
  source?: { name: string };
}

/** Tip item in gray tip JSON (tag 48271). */
export interface TipJsonItem {
  type: 'img' | 'qq' | 'nor' | 'url' | string;
  src?: string;
  uid?: string;
  txt?: string;
  col?: string;
  jp?: string;
}

/** Shape of the JSON document in gray tip (tag 48271). */
export interface TipJsonPayload {
  items: TipJsonItem[];
}

/** Shape of the XML document in action gray tip (tag 48214). */
export interface ActionXmlPayload {
  align: string;
  elements: Array<{
    type: 'qq' | 'img' | 'nor';
    uin?: string;
    col?: string;
    nm?: string;
    tp?: string;
    src?: string;
    jp?: string;
    txt?: string;
  }>;
}
