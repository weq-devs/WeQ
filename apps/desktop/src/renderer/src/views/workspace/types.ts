import type { FileSyncReceipt } from '../../lib/fileSendReconcile';
import type { ConversationReadingPosition } from '../../lib/conversationReadingPosition';
import type { MfCardPreview } from '../../components/mergeForward/model';
import type { MessageBubbleSkin, RecallInfo } from '@weq/service';
import type { Message, ProfileExtInfo } from '../../im-template/template';
import type { SetEmojiItem } from '@weq/codec';

export type RecentContactWire = {
  chatType: string | number;
  msgSeq: string;
  senderUid: string;
  targetUid: string;
  targetUin: string;
  sendTime: string;
  topTime: string;
  pinned: boolean;
  preview: unknown | null;
  previewDeferred?: true;
  senderDisplayName: string;
  senderNick: string;
  targetDisplayName: string;
  senderRemark: string;
  targetAvatar: string;
  targetRemark: string;
  /** 41148 — peer's group card; only set on temp c2c-from-group conversations. */
  targetGroupNick: string;
  /** 41220 — message-notify level. 1 = notify normally; else (observed 4) 免打扰/muted. */
  notifyLevel: number;
  /** 60001 — group code a temp c2c conversation started from; "0" when absent. */
  tempSourceGroupCode: string;
};

/** 置顶会话一行（recent_contact_top_table）。 */
export type RecentContactTopWire = {
  chatType: string | number;
  /** 41103 — 置顶时间，unix 秒。 */
  topTime: string;
  /** 会话键：c2c 是对端 uid，群是群号 —— 对齐 RecentContactWire.targetUid。 */
  targetId: string;
};

/** 隐藏会话一行（hidden_session_storage_table_v1），最后消息时间/预览已由后端解析。 */
export type HiddenSessionWire = {
  unreadCount?: number;
  storageKey: string;
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  resolvable: boolean;
  sendTime: string;
  senderUid: string;
  preview: unknown | null;
};

/** 删除会话一行（recent_contact_delete_storage），最后消息时间/预览已由后端解析。 */
export type DeletedSessionWire = {
  unreadCount?: number;
  sessionKey: string;
  chatType: number;
  targetUid: string;
  resolvable: boolean;
  sendTime: string;
  senderUid: string;
  preview: unknown | null;
  deleteTime: string;
};

/** 公众号摘要（listOfficialAccounts）—— wire 格式。 */
export type OfficialAccountWire = {
  unreadCount?: number;
  peerUid: string;
  displayName: string;
  targetUin: string;
  sendTime: string;
  prompt: string | null;
};

/** 服务号摘要（listServiceAccounts）—— wire 格式。 */
export type ServiceAccountWire = {
  unreadCount?: number;
  appId: string;
  displayName: string;
  avatarUrl: string | null;
  sendTime: string;
  prompt: string | null;
};

export type MessageWire = {
  localSent?: boolean;
  sentFromWeq?: true;
  livePush?: true;
  sourceFormat?: 'native' | 'protocol';
  source?: 'roaming';
  ntSeqVerified?: boolean;
  msgId: string;
  /** In-conversation sequence number (column 40003); the seq-window cursor. */
  msgSeq: string;
  /**
   * Column 40002 — the client-generated send `random`. The optimistic-message
   * reconciliation key (see OptimisticArk.cid): unlike msgId (server snowflake)
   * and msgSeq (per-conversation, and a DIFFERENT numbering for c2c vs the
   * server-fetched history), this value is known before sending and preserved
   * unchanged by the server.
   *
   * Optional: the gap-fetch path (`fetchGapMessages`) returns a lighter shape
   * that carries the server `contentHead.msgId` instead; those rows fall back to
   * '' and simply never participate in cid reconciliation (the main timeline —
   * where optimistic messages land — always has it).
   */
  msgRandom?: string;
  /**
   * Column 40005 — the sender-local client sequence (`contentHead.sequence`,
   * tag 5); c2c-only (group rows have no such column value → absent). A
   * private-chat reply must quote THIS number, not `msgSeq` — see
   * `composerQuote.composerQuoteElement`.
   */
  clientSeq?: string;
  senderUid: string;
  senderAtTime?: { name: string; kind: 'display' | 'nickname' };
  senderUin: string;
  sendTime: string;
  elements: unknown[];
  /** Sticker reactions (贴表情, column 40062); group-only, omitted when none. */
  setEmojiList?: SetEmojiItem[];
  /** Deleted origin: 'weq' (restorable) or 'qq' (native recall, not). */
  deletedKind?: 'weq' | 'qq';
  recall?: RecallInfo;
  /**
   * Per-message decoration from column 40801 (0 = not set).
   * `fontId1Raw` / `fontId2Raw` 是字体两槽位的原始 wire 值（41525 / 41531），
   * 转发时原样透传；不要用 `fontId` 反推（会丢 bit 16）。
   */
  decoration?: {
    cachedBubble?: MessageBubbleSkin;
    bubbleId: number;
    fontId: number;
    widgetId: number;
    fontId1Raw?: number;
    fontId2Raw?: number;
  };
};

/** The unified chat-message wire from the account router → local MessageWire. */
export type ChatMsgWire = {
  cachedBubbles?: MessageBubbleSkin[];
  localSent?: boolean;
  sentFromWeq?: true;
  livePush?: true;
  sourceFormat?: 'native' | 'protocol';
  source?: 'roaming';
  ntSeqVerified?: boolean;
  msgId: string;
  msgSeq: string;
  msgRandom?: string;
  /** 列 40005（发送方本地 client sequence，仅私聊）—— 私聊引用要发它。 */
  clientSeq?: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
  setEmojiList?: SetEmojiItem[];
  deletedKind?: 'weq' | 'qq';
  recall?: RecallInfo;
  decoration?: {
    bubbleId: number;
    fontId: number;
    widgetId: number;
    fontId1Raw?: number;
    fontId2Raw?: number;
  };
};

export type UserProfileWire = {
  uid: string;
  qid: string;
  uin: string;
  nick: string;
  avatarUrl: string;
  birthYear: number;
  birthMonth: number;
  birthDay: number;
  gender: number;
  age: number;
  signature: string;
  remark: string;
  intimacy: number;
  sigUpdateTime: number;
  isFriend: boolean;
  friendshipKnown?: boolean;
  customStatus?: {
    id?: number;
    desc?: string;
  };
  extRelation?: {
    preselectedIds: number[];
    displayId?: number;
  };
  extInfo?: ProfileExtInfo;
};

export type GroupMemberWire = {
  groupCode?: string;
  uid: string;
  uin: string;
  card: string;
  nick: string;
  joinTime: number;
  lastSpeakTime?: number;
  muteUntil?: number;
  adminFlag: number;
  memberFlag?: number;
  customTitle?: string;
  memberLevel?: number;
};

export type BuddyWire = {
  uid: string;
  qid: string;
  uin: string;
  categoryId: number;
};

export type CategoryWire = {
  id: number;
  name: string;
  buddyCount: number;
  sortOrder?: number;
};

export type BuddyRequestWire = {
  timestamp: number;
  peerUid: string;
  nick: string;
  verifyMsg: string;
  source: string;
  status: number;
  sourceGroupCode: string;
  initiator: number;
  isAccepted: number;
};

export type GroupNotifyWire = {
  msgTime: number;
  sequence?: string;
  status: number;
  verifyStatus: number;
  groupUin: string;
  groupName: string;
  operatedUid: string;
  operatedUin: string;
  operatedNick: string;
  operatorUid: string;
  operatorUin: string;
  operatorNick: string;
  opTime: number;
  remark: string;
  systemRemark: string;
  sourceTable: 'group_notify_list' | 'doubt_group_notify_list';
};

export type GroupDetailWire = {
  directory?: {
    role: 'owner' | 'admin' | 'member' | null;
    pinned: boolean;
    notifyLevel: number;
    unnamed: boolean;
    memberCount: number;
  } | null;
  groupCode: string;
  groupName: string;
  pinnedAnnounce: string;
  description: string;
  remark: string;
  ownerUid: string;
  createTime: number;
  maxMemberCount: number;
  memberCount: number;
  labels: string;
  entranceQ: string;
  customLabels: Array<{
    groupCode?: string;
    setterUid?: string;
    labelId?: string;
    setTimestamp?: string;
    content?: string;
  }>;
  address?: { locationName?: string };
};

/** 数据库查询返回的原始群精华类型 */
export type GroupEssenceWire = {
  msgSeq: number;
  msgRandom?: number;
  senderNick: string;
  setStatus: number;
  operatorNick: string;
  timestamp: number;
};

export type RenderElementWire = {
  type?: string;
  data?: Record<string, unknown>;
};

/**
 * 一条「乐观渲染」的合并转发消息 —— 只活在前端 state 里。
 *
 * 私聊的同步周期很长（群聊也慢），发出去之后不能干等 QQ 把消息同步回来才显示。
 * 所以发送时先在目标会话末尾插一张同款「聊天记录」卡片，带状态标识；它不写库、
 * 不落缓存文件，开关应用即消失。
 */
export type OptimisticForward = {
  hostReceived?: boolean;
  id: string;
  /** 目标会话 id（模板层 Conversation.id）。 */
  convId: string;
  title: string;
  /** 预览消息条数。 */
  count: number;
  /**
   * 卡片封面预览（标题 / 摘要 / 前 4 行）。与服务端生成的那份同口径（见
   * `@weqbot/protocol` 的 buildForwardCardMeta），同步回来后卡片不会变样。
   */
  preview: MfCardPreview;
  state: 'sending' | 'sent' | 'failed';
  afterSeq?: string;
  /** 发送成功后的长消息 id（卡片点开可拉取）。 */
  resId?: string;
  /** 客户端 `random`（`SendMessageOutcome.random`）—— 与 Ark 同款对账主键。 */
  cid?: string;
  /** 发送回执给出的会话内真实 seq —— 与 Ark 同款，用于排序与缺口判定。 */
  seq?: string;
  /** 普通会话零序号的未确认标记；成功设备回执除外。见 {@link OptimisticArk.seqRejected}。 */
  seqRejected?: boolean;
  error?: string;
  at: number;
};

/**
 * 一条「乐观渲染」的 Ark 卡片消息 —— 与 {@link OptimisticForward} 同一套做法。
 *
 * 卡片发出去之后不能干等 QQ 同步回来（私聊滞后更明显），先在目标会话末尾插一张同款
 * 卡片 + 状态标识。它只活在前端 state 里，不写库、不落缓存文件，开关应用即消失：
 *
 *   - 图文 / 自定义 JSON：发出去的就是这段 JSON，从一开始就是最终形状；
 *   - 推荐好友 / 推荐群：先画一张本地占位卡，拿到服务端取回的那份 arkJson 后原位替换；
 *   - 位置卡片：本地按发送字段拼一张（渲染器走静态地图缩略图那条路）。
 */
export type OptimisticArk = {
  hostReceived?: boolean;
  id: string;
  /** 目标会话 id（模板层 Conversation.id）。 */
  convId: string;
  /** 卡片渲染用的 ark JSON。 */
  arkData: string;
  /**
   * 对账签名（`arkCardSignature`）：真消息同步回来时用它把乐观条目收掉。
   * 「服务端会重新生成卡片内容」的位置卡片走坐标，其余的走 JSON 本体。
   */
  signature: string;
  /**
   * 这条消息的客户端 `random`（`SendMessageOutcome.random`）—— 对账**主键**。
   *
   * 发送请求里就有它、服务端回执原样带回、写进本地库的 40002（`ChatMsgWire.msgRandom`）、
   * 并被服务端历史 / 漫游原样保留。所以「真消息同步回来」时拿 `msgRandom` 一比就能精确
   * 收掉，且不依赖任何服务端分配的编号。
   *
   * 为什么不能用别的：
   *   - `msgId`（40001）是**服务端雪花 id**，发送前根本不知道，对不上（旧代码拿
   *     `random & 0x7fffffff` 当 msgId 推导，与真实的 40001 无任何关系，那条分支从来没命中过）；
   *   - `msgSeq`（40003）是会话内序号，**私聊本地库与服务端漫游还是两套编号**，
   *     只有群聊能当辅助判据（见 {@link OptimisticArk.seq}）。
   *
   * 位置卡片那条 trpc 回包解析不出 random，取不到时回退到内容签名。
   */
  cid?: string;
  /**
   * 发送回执给出的**会话内真实 seq**（群聊 `groupSequence` / 私聊 `privateSequence`）。
   *
   * 实测（2026-09-27）这就是**本地库 40003 那一套**：群聊回执 seq 与库里 40003 直接相等；
   * 私聊回执是「本地 max + 1、逐条递增」。所以它可用于：
   *   - **排序**（乐观条目按它混进真实消息之间，而不是一律置底）；
   *   - **缺口判定**的修正（见 chatPane 的 `messageGapCount`）；
   *   - 作为 `cid` 之后的次要对账判据。
   *
   * 普通会话 `seq === 0` 可能是 markdown / 签名错的 ark 这类静默丢弃；成功设备
   * 回执本来就没有普通会话序号，不套用这个判据。见 {@link OptimisticArk.seqRejected}。
   */
  seq?: string;
  /**
   * 普通会话回执 seq 为 0 的未确认标记：静默丢弃时 `result=0`、`errMsg=''` 也可能与
   * 成功一样。这种条目没有可信序号，排序置底并提示可能未送达；成功设备回执不打此标记。
   */
  seqRejected?: boolean;
  state: 'sending' | 'sent' | 'failed';
  afterSeq?: string;
  error?: string;
  at: number;
};

export type PendingScrollRestore = {
  conversationId: string;
  position: ConversationReadingPosition;
};

/**
 * 一条「乐观渲染」的普通消息（文本 / @ / 表情 / 图片 / 视频 / 语音 / 文件 / 引用 /
 * 弹射表情 / 互动表情…）—— 与 {@link OptimisticArk} 同一套做法。
 *
 * 发出去之后不等 QQ 同步回来，先在目标会话里按真实气泡渲染出这条消息 + 状态标识；
 * 本地媒体走 `localPath` / `localPreviewUrl` 直接预览。只活在前端 state 里，不写库、
 * 不落缓存，开关应用即消失。元素形状与真实消息的 `qqElements` 同构（见
 * `composerSend.buildOptimisticRender`），所以同步到位后不会跳变。
 */
export type OptimisticMessage = {
  hostReceived?: boolean;
  transferId?: string;
  mediaSend?: {
    scope: string;
    subject: string;
    conversationName: string;
    conversationKind: 'group' | 'c2c';
  };
  id: string;
  /** 目标会话 id（模板层 Conversation.id）。 */
  convId: string;
  /** 纯文本预览（会话列表 / 气泡文本）。 */
  body: string;
  /** 渲染元素（`{type,data}`，与真实消息的 `qqElements` 同形）。 */
  elements: unknown[];
  composerDraft?: Message['composerDraft'];
  decoration?: Message['decoration'];
  /** 发送字体首次绘制前已进入队列，保留草稿和媒体持有。 */
  preparingFont?: boolean;
  /**
   * 内容签名（cid / seq 都拿不到时的对账兜底，如 AI 声聊 0x929b_0 回执、闪传
   * 0x93d7 回执）。**任意一个**命中就收掉；每个签名各自按出现次数消耗。
   *   · AI 声聊：`aiVoice:<回执音频哈希>`。
   *   · 闪传：`flash:<filesetUuid>`（Windows / 安卓收到的真卡片）或
   *     `flash:<分享短码>`（Linux / 鸿蒙收到的降级纯文本）—— 两者互斥，哪条先
   *     回来都能把乐观卡片收掉。
   */
  signatures?: string[];
  awaitingAiVoice?: boolean;
  generatedExistingMsgIds?: string[];
  /** 文件发布没有普通消息序号，按文件 ID 与发送前的消息快照对账。 */
  fileSync?: FileSyncReceipt;
  state: 'queued' | 'sending' | 'sent' | 'failed';
  afterSeq?: string;
  error?: string;
  /** 客户端 `random`（回执带回）—— 对账主键。 */
  cid?: string;
  /** 发送请求的 random，正式记录可能先于 RPC 回执到达。 */
  requestRandom?: string;
  /** 回执给出的会话内真实 seq（群聊 / 私聊同一套）—— 用于排序与缺口判定。 */
  seq?: string;
  /** 普通会话零序号的未确认标记；成功设备回执除外。 */
  seqRejected?: boolean;
  at: number;
};
