

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
  GrayTipInviteElement,
  GrayTipFileRecvElement,
  GrayTipTempSessionElement,
  WalletElement,
  ArkElement,
  MfaceElement,
  MarkdownElement,
  MultiMsgElement,
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
  /** 内联键盘（机器人按钮）. 未观测. */
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
   * 文件接收完成灰条。Carries FILE metadata (45402 fileName ×2, 45405 size,
   * 45407 md5, 45503 fileToken) rather than any gray-tip field — QQ writes it
   * as a separate row alongside the real FILE message. Verified: the sender
   * (40020) is ALWAYS the peer, never this account, so it marks "对方发来的
   * 文件已接收完成". Row-level msgType is 40011=5/40012=1 (system tip) or
   * 40011=1/40012=2.
   */
  FILE = 10,
  /** 频道消息 Feed. 未观测. */
  FEED_CHANNEL_MSG = 11,
  /** XML 灰条。历史上被 WeQ 当作「邀请」处理，实为通用 XML 消息。 */
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

export enum CallSubType {
  VIDEO_ACCEPTED = 2,
  VIDEO_REJECTED_BY_US = 3,
  VIDEO_REJECTED_BY_PEER = 6,
  VOICE_ACCEPTED = 7,
  VOICE_REJECTED_BY_US = 8,
  VOICE_REJECTED_BY_PEER = 11,
  VIDEO_HANDLED_OTHER_DEVICE = 12,
  VOICE_HANDLED_OTHER_DEVICE = 13,
  SCREEN_SHARE_ACCEPTED = 19,
  SCREEN_SHARE_REJECTED = 22,
  REMOTE_ASSIST_ACCEPTED = 33,
  REMOTE_ASSIST_FAILED = 34,
}

export enum CallType {
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
