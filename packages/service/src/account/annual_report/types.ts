/** Shared contracts for the compile-time annual-report page system. */

import type {
  C2cInitiationTally,
  C2cMsg,
  C2cPeerDayTally,
  DressTally,
  GroupInteractionTally,
  SentSpeechRow,
  SentWeekdayHourlyGrid,
} from '@weq/db';

/** 三类个性装扮。与 `account.dressup.*` 的 kind 取值一致。 */
export type DressKind = 'bubble' | 'font' | 'widget';

/**
 * 款名解析器 —— 由宿主（主进程）注入，因为名字的两个来源都在 service 之外：
 * 账号的「已装」清单（DressService）与仓库里的静态商城榜单（resources/dress）。
 * 不注入时报告照常出，只是每款显示 `#itemId`。
 */
export type DressNameResolver = (kind: DressKind, itemIds: number[]) => Record<number, string>;

export type ReportScope = {
  includeC2c: boolean;
  includeGroups: boolean;
  includeDataline: boolean;
  includeServiceAccounts: boolean;
};

export const DEFAULT_REPORT_SCOPE: ReportScope = {
  includeC2c: true,
  includeGroups: true,
  includeDataline: false,
  includeServiceAccounts: false,
};

export type ReportPageManifest = {
  id: string;
  title: string;
  description: string;
  order: number;
  version: string;
  apiVersion: number;
  category: string;
  enabledByDefault: boolean;
};

export type AnnualReportPreferences = {
  mode: 'default' | 'custom';
  enabledPageIds: string[];
  order: string[];
  exportPageIds: string[];
};

export type ReportManifest = {
  /** The report's period. `ALL_TIME_YEAR` (0) = 「历史以来」. */
  year: number;
  /**
   * Selectable periods, ascending, with `ALL_TIME_YEAR` (0) first when the
   * account has any data at all. Only years the account actually *sent* a
   * message in are listed — silent years have no report to show.
   */
  availableYears: number[];
  scope: ReportScope;
  /** Effective ordered page collection for browsing (data-eligible ∩ user preference). */
  pages: ReportPageManifest[];
  /** All compiled-in pages, including disabled / data-ineligible ones, for the DIY manager. */
  availablePages: ReportPageManifest[];
  preferences: AnnualReportPreferences;
};

/**
 * 一条可以进入「QQ 空间回忆」页的说说的归一化形态。
 *
 * 与 `@weq/account/web` 的 {@link QzoneEmotion} 同源，但这里刻意只保留页面要画的
 * 字段 —— 评论数来自说说列表自带的 `cmtnum`（精确）；点赞数是后来按 tid 走
 * qz_opcnt2 权威源补的，没补/补失败时是 null，页面据此退回「评论最多」口径。
 */
export type ReportQzonePost = {
  /** 说说 tid —— 点赞补拉与回跳 QQ 空间的句柄。 */
  tid: string;
  /** 发表时间 unix 秒。 */
  time: number;
  /** 说说正文（qzone 富文本 token 原样保留，渲染层只做安全文本展示）。 */
  content: string;
  /** 图片 URL（取消息列表给到的最大变体）；渲染层经 weq-media://album 代理加载。 */
  images: string[];
  /** 视频封面 URL（纯图/纯文字说说为空串）。 */
  videoCover: string;
  /** 是否带视频（视频封面可能缺失，渲染层画「视频」角标兜底）。 */
  hasVideo: boolean;
  /** 精确评论数（说说列表自带）。 */
  commentCount: number;
  /** 精确点赞数；未拉取/拉取失败为 null。 */
  likeCount: number | null;
  /** 仅自己可见。 */
  isPrivate: boolean;
};

/**
 * 主进程注入的 QQ 空间读能力 —— 年度报告里唯一的在线页面用它做 availability /
 * compute。宿主（app_context）把 WebQueryService + 在线 QQ 探测包成这个接缝，
 * service 层因此不依赖 web cgi 的实现细节，离线环境拿不到 p_skey 时自然 unavailable。
 */
export type ReportQzoneCapability = {
  /**
   * 当前账号能否走 qzone web cgi：有在线 QQ 实例即可（ptlogin2 本地快速登录
   * 兜底换 p_skey，不需要「自动注入 QQ」已开启）。
   */
  canQuery(): Promise<boolean> | boolean;
  /**
   * 拉取本账号在 [startSec, endSec)（unix 秒，0/0 = 不限）内的全部说说。
   * 分页去重、倒序返回；宿主负责 600ms 翻页间隔与翻页上限（与好友空间导出同源）。
   */
  fetchPosts(startSec: number, endSec: number): Promise<ReportQzonePost[]>;
  /**
   * 读一条说说的权威点赞数（qz_opcnt2）。失败返回 null —— 点赞是增强项，
   * 补不齐时页面退回「评论最多」，不让整页因此失败。
   */
  fetchLikeCount(tid: string): Promise<number | null>;
};

export type ReportPageStatus = 'ok' | 'error' | 'unavailable';

export type ReportPageError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type ReportPageResult<D = unknown> = {
  pageId: string;
  version: string;
  status: ReportPageStatus;
  data: D | null;
  error?: ReportPageError;
  /** 本页在这一年/口径下没有可展示的数据（`status: 'unavailable'` 时给出原因）。 */
  reason?: string;
};

/**
 * Whether a page qualifies for the account / year / scope.
 *
 * 资格检查与页面数据一样是**惰性**的：`getManifest` 只返回候选页，不逐页探测；
 * `getPageData` 在真正计算这一页时才跑 `availability`。不合格的页面以
 * `status: 'unavailable'` 返回，渲染层随后把它从 deck 里摘掉。
 */
export type PageAvailability = {
  available: boolean;
  reason?: string;
};

/**
 * Typed read-only query surface handed to page availability/compute hooks.
 * Created against the live `AccountSession`; pages never see the session,
 * a database handle or SQL.
 */
export type ReportQueries = {
  /**
   * Message-volume stats for the overview card. One pass per table, no body
   * decode — deliberately the cheapest global aggregates we can offer.
   */
  overview: {
    /**
     * Sent / received split for one half-open time window [startTime, endTime)
     * (unix seconds), across c2c + group tables only (dataline excluded).
     */
    countByDirection(
      startTime: number,
      endTime: number,
    ): Promise<{
      c2cSent: number;
      c2cReceived: number;
      groupSent: number;
      groupReceived: number;
    }>;
  };
  /**
   * 消息装扮（列 40801）的聚合。年度报告「最喜欢的装扮」页专用。
   */
  dress: {
    /**
     * 我在 [startTime, endTime)（unix 秒）内发出的消息里，每款气泡 / 字体 / 挂件
     * 各被用在多少条消息上。私聊 + 群聊各一次单列扫描后合并，不解码消息体。
     */
    tally(startTime: number, endTime: number): Promise<DressTally>;
    /**
     * 款名解析（同步，纯本地）。来源是账号「已装」清单里记下的商城元数据 + 仓库里
     * 那份静态商城榜单，两者都拿不到的 itemId **不出现**在结果里 —— 渲染层退回
     * 「#itemId」，不去猜一个假名字。
     */
    names(kind: DressKind, itemIds: number[]): Record<number, string>;
  };
  /**
   * 系统表情的名字解析 —— 年度报告「我的话」页给 favourite face 取名。
   *
   * 名字的唯一可靠来源是账号的 emoji.db（`base_sys_emoji_table`），而读 emoji.db
   * 需要 Platform / native 句柄，service 层不持有，所以由宿主注入解析器。消息里
   * 的 `faceText`（/捂脸 / [捂脸]）也可以取名，但小黄脸那一批不带 text —— 两条
   * 来源在页面 compute 里兜底拼接：先查这里，查不到再用消息自己的 faceText。
   */
  emoji: {
    names(faceIds: number[]): Promise<Record<number, string>>;
  };
  /**
   * 年度报告「我的话」页的原始素材：我自己发出的消息正文。
   *
   * 与 overview/dress 的「不解码 body 的轻扫描」相反，这一页必须看每条消息说了
   * 什么，所以两张表各做一次全量 40800 解码后合并返回。只有这一页用；返回的
   * 数组是共享只读的，调用方不得原地修改。
   */
  speech: {
    sentRows(startTime: number, endTime: number): Promise<SentSpeechRow[]>;
  };
  /**
   * 群聊专用聚合 —— 年度报告「我的主场」页的素材。排行 SQL 封装在
   * `@weq/db` 的 `GroupMsgDb`，这里只做 typed 接缝。
   */
  group: {
    /**
     * 口径内我在每个「我的群」里发出的消息条数 + 全群总消息数，降序素材。
     *
     * 底层是 group_detail 全量元数据 ⋈ 一次 `GROUP BY 群号, 方向` 的群消息
     * 轻扫描，不解码消息体。方向判据与其它页面共用同一套 self marker
     * （senderUid 优先、selfUin 兜底）；两个都没有时每个群都返回 0，
     * 页面会因此不展示。
     */
    countRows(
      startTime: number,
      endTime: number,
    ): Promise<
      Array<{
        groupCode: string;
        groupName: string;
        memberCount: number;
        /** 口径内自己在群里的发出条数。 */
        sentCount: number;
        /** 口径内全群消息总数。 */
        totalCount: number;
      }>
    >;
    /**
     * 某一个群在时间窗内的全体正文（解码后）—— 只给冠军群算词云，扫描一次。
     * 返回的数组是共享只读的，调用方不得原地修改。
     */
    speechRows(groupCode: string, startTime: number, endTime: number): Promise<SentSpeechRow[]>;
    /**
     * 我在一个群里的成员身份：群角色 / 自定义头衔 / 群等级与等级名。
     *
     * 本地没有我的成员行或群元数据时返回 null，页面据此优雅降级（只画群名
     * 与条数，不硬编一个假头衔）。
     */
    standing(groupCode: string): Promise<{
      groupCode: string;
      role: 'owner' | 'admin' | 'member';
      customTitle: string;
      memberLevel: number;
      levelName: string;
      memberCount: number;
    } | null>;
    /**
     * 群聊互动页的原始聚合 —— 戳一戳 / @ / 被 @ / 复读。SQL 与正文解码都封装
     * 在 `GroupMsgDb.tallyInteractions` 里，这里只做窗口记忆化与身份 marker 透传。
     */
    interactionTally(startTime: number, endTime: number): Promise<GroupInteractionTally>;
    /**
     * 批量取群资料（群名等）。只返回本地有资料的群；查不到的由 compute 用群号兜底。
     */
    details(groupCodes: string[]): Promise<Array<{ groupCode: string; groupName: string }>>;
    /**
     * 一个群里若干成员的群名片 / 昵称。用来给「被我戳/被我 @ 最多的人」补名字；
     * 已经退群、本地成员表查不到的人返回空，页面退回消息里自带的展示名。
     */
    memberBriefs(
      groupCode: string,
      uids: string[],
      uins: string[],
    ): Promise<Array<{ uid: string; uin: string; card: string; nick: string }>>;
    /**
     * 一次扫描把本地全部「在群成员」关系取回来（群号 × uid/uin + 展示名），
     * 供跨群重合度页在内存里按群分桶。表很小（几万行），单次无 JOIN / ORDER
     * 扫描比「每群一条查询」快得多。返回数组是共享只读的，调用方不得原地修改。
     */
    allActiveMembers(): Promise<
      Array<{
        groupCode: string;
        uid: string;
        uin: string;
        nick: string;
        card: string;
      }>
    >;
  };
  /**
   * 好友名册 —— 权威的好友判定来源是 `buddy_list`（profile_info.db），不是
   * 消息往来。生态位页用它把「已经是好友」的群友挡在推荐之外。
   */
  buddies: {
    /** 全部好友的 uid / uin。只读共享数组，调用方不得修改。 */
    list(): Promise<Array<{ uid: string; uin: string }>>;
  };
  /** Engine-level metadata, not page data. */
  meta: {
    /**
     * Oldest message sendTime (unix seconds) across c2c + group tables, or
     * null when the account has no messages at all. The denominator anchor for
     * 「历史以来」per-day figures; the engine caches the result.
     */
    oldestMessageTime(): Promise<number | null>;
    /**
     * The local-time years in which the account sent at least one c2c or group
     * message, ascending. This — not the [oldest..now] span — is the set of
     * selectable report years: a year you never spoke in has no report.
     */
    sentYears(): Promise<number[]>;
    /**
     * 当前账号自己的 uid / uin（uid 缺失时为空串）。跨群重合度页要从成员里
     * 把自己摘出去。
     */
    selfIdentity(): Promise<{ uid: string; uin: string }>;
    /**
     * 本地资料缓存里判定为机器人账号的 uid 集合 —— 群成员扫描会撞见群机器人，
     * 它们不是「可以加好友的群友」，生态位页要把它们筛掉。
     */
    botUids(): Promise<Set<string>>;
  };
  /**
   * 私聊专用聚合 —— 年度报告「私聊火花」页的素材。SQL 全部封装在
   * `@weq/db` 的 `C2cMsgDb` 里，这里只做 typed 接缝。
   */
  c2c: {
    /**
     * 一个时间窗内按「会话 × 本地自然日」聚合的条数（含我发/合计），
     * 一次扫描、不读消息体。自然年窗口由调用方从 `reportYearUnixRange` 拿。
     *
     * 按时间窗记忆化：多个页面（私聊火花 / 好友榜）问同一个窗口时共享同一次
     * 扫描，因此返回的数组是**共享只读**的 —— 调用方只能读，不能原地排序或修改。
     */
    peerDayTallies(startTime: number, endTime: number): Promise<C2cPeerDayTally[]>;
    /**
     * 一个时间窗内每个会话的开场次数（我 / 对方），统计单位是对话不是消息。
     * 底层只扫几列元数据，按 `CONVERSATION_GAP_SECONDS`（静默超 5 小时算新开场）
     * 切分 —— 与「私聊分析」的主动发起口径同源。
     */
    initiationTallies(startTime: number, endTime: number): Promise<C2cInitiationTally[]>;
    /**
     * 某会话在一个半开时间窗内的完整消息（oldest first）。只用于给「最忙的
     * 那一天」解码正文做热词，因此窗口是单个 peer-day，而不是整份报告。
     */
    peerMessagesInWindow(peerUid: string, startTime: number, endTime: number): Promise<C2cMsg[]>;
    /**
     * Batch peer display info (nick / remark / uin) by uid. Rows missing from
     * the local profile cache are simply absent; the page falls back to a
     * uid-derived label.
     */
    peerProfiles(
      uids: string[],
    ): Promise<Array<{ uid: string; uin: string; nick: string; remark: string }>>;
  };
  /**
   * 「自己发出」的时间分布 —— 年度报告「我的作息」页专用，私聊 + 群聊一次合并。
   */
  rhythm: {
    /**
     * 我在 [startTime, endTime)（unix 秒）内发出的消息按「星期 × 本地小时」聚合，
     * 返回 7×24 矩阵（0 行 = 周日）。私聊方向由行内数据自证，群聊用与 overview
     * 同一个 self marker（uid 优先、uin 兜底）。两次单列扫描后合并，不解码消息体。
     */
    sentWeekdayHourlyTallies(startTime: number, endTime: number): Promise<SentWeekdayHourlyGrid>;
  };
  /**
   * QQ 空间回忆 —— 唯一的在线页面。素材不在本地聊天库里，而是本账号的空间
   * （走 qzone web cgi，需要在线 QQ 的 ptlogin/p_skey）。没有注入宿主能力时
   * availability 直接不通过，离线环境这页不会出现在 deck 里。
   */
  qzone: {
    /** 在线实例探测（有 pid 即可；ptlogin 本地快速登录兜底换 p_skey）。 */
    canQuery(): Promise<boolean> | boolean;
    /**
     * 一个时间窗内自己的全部说说。按窗口记忆化：availability 探一次、compute
     * 再取同一窗口时共享同一批翻页结果。返回的数组是共享只读的，调用方不得修改。
     */
    posts(startTime: number, endTime: number): Promise<ReportQzonePost[]>;
    /** 一条说说的权威点赞数；宿主补拉失败返回 null，页面退回评论口径。 */
    likeCount(tid: string): Promise<number | null>;
  };
};

export type PageComputeCtx = {
  year: number;
  scope: ReportScope;
  q: ReportQueries;
  signal: AbortSignal;
  dataRevision: string;
};

export type PageAvailabilityCtx = {
  year: number;
  scope: ReportScope;
  q: ReportQueries;
  dataRevision: string;
};

export type ReportPageDefinition<D = unknown> = {
  manifest: ReportPageManifest;
  /** Cheap eligibility probe run at manifest time. Absent = always available. */
  availability?: (ctx: PageAvailabilityCtx) => Promise<PageAvailability>;
  compute: (ctx: PageComputeCtx) => Promise<D>;
  cacheable?: boolean;
};
