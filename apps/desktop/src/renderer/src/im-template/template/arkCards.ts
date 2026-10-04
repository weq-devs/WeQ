/**
 * Ark 卡片面板的**纯逻辑**：草稿 → ark JSON、载荷类型、默认模板。
 *
 * 刻意不碰 React、也不碰任何 IPC —— 面板只负责收集输入，真正下发由 chatPane 交给
 * 应用层（`onSendArk`），跟 linkCardPanel / aiVoicePanel 一个套路。
 *
 * 五种卡片里，「图文」与「自定义 JSON」最终都是**同一件事**：一段 ark JSON 编成
 * `lightApp` 元素（`{kind:'ark', arkData}`）发出去。区别只是 JSON 是面板帮用户拼的、
 * 还是用户自己写的。
 */

/** 图文卡片用的 ark app（`com.tencent.tuwen.lua` 的 news 模板）。 */
const TUWEN_ARK_APP = 'com.tencent.tuwen.lua';
const TUWEN_ARK_VIEW = 'news';

/**
 * 群报名卡片用的 ark app（`com.tencent.activity.md` 的 activity 模板）。
 *
 * 真卡片由 QQ 服务端按 OIDB 0x921b_0 的字段生成，本机拿不到那份 JSON；下面拼出来的
 * 这一份**只给预览与乐观卡片用**（见 {@link buildGroupSignupArkJson}）—— 形状照着
 * 渲染器里那张群活动卡的字段来（见 components/ark/QqArk.tsx 的 `ArkActivity`）。
 */
const SIGNUP_ARK_APP = 'com.tencent.activity.md';
const SIGNUP_ARK_VIEW = 'activity';

/** 摘要固定文案 —— 与 SnowLuma `send_tuwen_ark` 的 summary 默认值一致。 */
export const LINK_CARD_SUMMARY = '[分享]';

/**
 * 默认图标（preview_url）—— 取自 SnowLuma `send_tuwen_ark` 的默认预览图
 * （QQ 自带的一张分享配图），用户留空时用它。
 */
export const LINK_CARD_DEFAULT_ICON =
  'https://tangram-1251316161.file.myqcloud.com/files/20210721/e50a8e37e08f29bf1ffc7466e1950690.png';

export const LINK_CARD_MAX_TITLE_CHARS = 80;
export const LINK_CARD_MAX_DESC_CHARS = 200;
export const LINK_CARD_MAX_URL_CHARS = 512;

/** 图文卡片草稿（面板「图文」tab 的表单状态）。 */
export type LinkCardDraft = {
  /** 跳转链接（必填，http/https）。 */
  jumpUrl: string;
  /** 标题（必填）。 */
  title: string;
  /** 描述（可选，默认空）。 */
  desc: string;
  /** 图标 / 预览图（可选，留空用 {@link LINK_CARD_DEFAULT_ICON}）。 */
  previewUrl: string;
};

/** 一张空白卡片草稿（图标留空 = 用默认图）。 */
export function emptyLinkCardDraft(): LinkCardDraft {
  return { jumpUrl: '', title: '', desc: '', previewUrl: '' };
}

/** 留空时回落到默认图标。 */
export function resolvedLinkCardIcon(draft: LinkCardDraft): string {
  return draft.previewUrl.trim() || LINK_CARD_DEFAULT_ICON;
}

// ---- 群报名（OIDB 0x921b_0）-----------------------------------------------

export const SIGNUP_TITLE_MAX_CHARS = 100;
export const SIGNUP_DETAIL_MAX_CHARS = 4000;
export const SIGNUP_MAX_COUNT_DEFAULT = 200;
/** 协议侧可调上限（f8）；与 MCP 工具 `send_group_signup` 的校验保持一致。 */
export const SIGNUP_MAX_COUNT_LIMIT = 200;

/** 报名方式：与协议 `signupMethod` 一一对应（1 = 直接报名，2 = 上传图片）。 */
export type SignupMethod = 'direct' | 'image';

/**
 * 群报名草稿（面板「报名」tab 的表单状态）。
 *
 * 目标群号写在草稿里（协议 0x921b_0 本身就以群号寻址，不是走常规发消息那条路），
 * 不跟随当前会话 —— 与「推荐群」那栏一样，可以发到自己不在里的群之外任何群。
 */
export type SignupDraft = {
  /** 目标群号（纯数字）。 */
  groupCode: string;
  /** 标题（如「找搭子」「图片收集」）。 */
  title: string;
  /** 详情正文。 */
  detail: string;
  /** 报名截止时间；空 = 不截止。 */
  deadline: string;
  /** 报名方式。 */
  method: SignupMethod;
  /** 报名人数上限（纯数字文本，默认 200）。 */
  maxCount: string;
  /** 附带图片直链（可选；method=image 时用）。 */
  imageUrl: string;
};

/** 一张空白报名草稿；`groupCode` 传入则预填（在群聊里打开面板时用当前群号）。 */
export function emptySignupDraft(groupCode = ''): SignupDraft {
  return {
    groupCode,
    title: '',
    detail: '',
    deadline: '',
    method: 'direct',
    maxCount: String(SIGNUP_MAX_COUNT_DEFAULT),
    imageUrl: '',
  };
}

/** 报名截止时间的解析结果：`ok` 之外带上人读的错误与东八区可读串。 */
export type SignupDeadlineResult =
  | { ok: true; seconds: null; label: string }
  | { ok: true; seconds: number; label: string }
  | { ok: false; error: string };

/**
 * 报名截止时间解析：空 = 不截止；接受 10 位 unix 秒、带时区的 ISO 串，或「东八区
 * 当地」的 `YYYY-MM-DD HH:mm[:ss]` / `YYYY/MM/DD HH:mm`（无时区时按 +08:00 理解）。
 */
export function resolveSignupDeadline(input: string): SignupDeadlineResult {
  const text = input.trim();
  if (!text) return { ok: true, seconds: null, label: '不截止' };
  let seconds: number;
  if (/^\d{10}$/.test(text)) {
    seconds = Number(text);
  } else {
    const m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      // 当地日期时间 = 东八区(+08:00)：先按 UTC 算再减 8 小时。
      seconds =
        Math.floor(
          Date.UTC(
            Number(m[1]),
            Number(m[2]) - 1,
            Number(m[3]),
            Number(m[4]),
            Number(m[5]),
            Number(m[6] ?? '0'),
          ) / 1000,
        ) -
        8 * 3600;
    } else {
      const ms = Date.parse(text);
      if (Number.isNaN(ms)) {
        return {
          ok: false,
          error: '时间无法识别，可用「2026-10-10 00:00」、带时区 ISO 串或 10 位 unix 秒',
        };
      }
      seconds = Math.floor(ms / 1000);
    }
  }
  return { ok: true, seconds, label: formatSignupDeadline(seconds) };
}

/** unix 秒 → 东八区可读串（回显 / 预览用）。 */
export function formatSignupDeadline(seconds: number): string {
  return new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * 群报名草稿 → **预览 / 乐观卡片用**的 ark JSON。
 *
 * 真卡片由 QQ 服务端按 0x921b_0 的字段生成，本机拿不到那份 JSON；这里拼出来的这一份
 * 只给面板预览与本地乐观卡片用 —— 形状照着渲染器里那张群活动卡的字段来
 * （见 components/ark/QqArk.tsx 的 `ArkActivity`）。
 */
export function buildGroupSignupArkJson(draft: SignupDraft): string {
  const title = draft.title.trim();
  const detail = draft.detail.trim();
  const maxCount = Number.parseInt(draft.maxCount, 10);
  const deadline = resolveSignupDeadline(draft.deadline);
  const cover = draft.imageUrl.trim();
  return JSON.stringify({
    app: SIGNUP_ARK_APP,
    view: SIGNUP_ARK_VIEW,
    prompt: `[群报名] ${title}`.trim(),
    meta: {
      activity: {
        title,
        desc: detail,
        // 发出去就是报名中；是否已结束由服务端按 deadline 决定。
        isEnabled: true,
        ongoingStatusLabel: '报名中',
        joinLabel: Number.isSafeInteger(maxCount) ? `限 ${maxCount} 人` : '',
        freeLabel: draft.method === 'image' ? '上传图片报名' : '直接报名',
        buttonText: '立即报名',
        tag: '群报名',
        ...(deadline.ok && deadline.seconds !== null ? { deadline: deadline.label } : {}),
        ...(cover ? { cover } : {}),
      },
    },
  });
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** 链接展示用的主机名（徽标那行）。取不到就空着。 */
export function hostOf(value: string): string {
  try {
    return new URL(value.trim()).host;
  } catch {
    return '';
  }
}

/**
 * 图文草稿 → ark JSON。
 *
 * 形状照 `docs/database/nt_msg/elements/ark.md`：顶层 app / view / prompt / meta，
 * 内容挂在 `meta.news` 里（渲染器按 app → 布局表读 title/desc/preview/jumpUrl）。
 */
export function buildTuwenArkJson(draft: LinkCardDraft): string {
  const title = draft.title.trim();
  const desc = draft.desc.trim();
  const icon = resolvedLinkCardIcon(draft);
  return JSON.stringify({
    app: TUWEN_ARK_APP,
    view: TUWEN_ARK_VIEW,
    // 会话列表外显文案：QQ 惯例是「[分享] 标题」。
    prompt: `${LINK_CARD_SUMMARY} ${title}`.trim(),
    meta: {
      news: {
        title,
        desc,
        summary: LINK_CARD_SUMMARY,
        jumpUrl: draft.jumpUrl.trim(),
        preview: icon,
        tagIcon: icon,
      },
    },
  });
}

/** 「自定义 JSON」tab 的初始模板 —— 一张新闻卡，照着改比从空白写起容易。 */
export const ARK_JSON_TEMPLATE = JSON.stringify(
  {
    app: TUWEN_ARK_APP,
    view: TUWEN_ARK_VIEW,
    prompt: '[分享] 卡片标题',
    meta: {
      news: {
        title: '卡片标题',
        desc: '卡片描述',
        jumpUrl: 'https://example.com',
        preview: LINK_CARD_DEFAULT_ICON,
      },
    },
  },
  null,
  2,
);

/** JSON 校验结果：`ok` 之外带上人读的错误，面板直接显示。 */
export type ArkJsonCheck = { ok: true; pretty: string } | { ok: false; error: string };

/**
 * 校验用户手写的 ark JSON（非空 + 能 parse + 是对象）。
 * 顺手返回格式化后的文本，方便「格式化」按钮与发出去的内容一致。
 */
export function checkArkJson(text: string): ArkJsonCheck {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'JSON 不能为空' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: `不是合法 JSON：${error instanceof Error ? error.message : ''}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'ark 卡片顶层必须是一个 JSON 对象' };
  }
  return { ok: true, pretty: JSON.stringify(parsed, null, 2) };
}

/** 十进制度坐标校验（面板侧只做「填了没 / 是不是数字」的轻校验）。 */
export function isDecimalCoordinate(value: string, limit: number): boolean {
  const text = value.trim();
  if (!text) return false;
  const num = Number(text);
  return Number.isFinite(num) && Math.abs(num) <= limit;
}

/**
 * 一条地点搜索建议。
 *
 * 与主进程 `LbsService.suggestPlaces` 的返回结构一致，但这里**按结构声明**而不是
 * import —— 模板层不依赖 service（与 types.ts 里 OnlineStatusInfo 同一条规矩）。
 */
export interface ArkPlaceSuggestion {
  id: string;
  /** 地点名称（Poi 名）。 */
  title: string;
  /** 详细地址（腾讯返回的地址**已去掉省市区前缀**）。 */
  address: string;
  /** 省市区。 */
  region: string;
  latitude: number;
  longitude: number;
}

/** 逆地址解析结果（点选坐标 → 可填进卡片的文字）。 */
export interface ArkResolvedAddress {
  /** 地点名称建议（地标 / 人性化地址），可能为空串。 */
  title: string;
  /** 详细地址（街道 + 门牌）。 */
  address: string;
  region: string;
}

/**
 * 位置卡片需要的地理能力，由应用层注入（实现见主进程的腾讯位置服务 WebService）。
 *
 * 放在应用层而不是面板里做，有两个理由：渲染层 CSP 是 `connect-src 'self'`，面板
 * 直连 `apis.map.qq.com` 要放开连接边界；而且 key 不该落进前端代码。
 */
export interface ArkLocationProvider {
  /** 关键词输入提示；`center` 是当前地图中心，用于按距离排序。 */
  suggest(
    keyword: string,
    center: { latitude: number; longitude: number },
  ): Promise<ArkPlaceSuggestion[]>;
  /** 逆地址解析：地图点选坐标 → 「地点名称 + 省市区 + 详细地址」。 */
  reverse(latitude: number, longitude: number): Promise<ArkResolvedAddress>;
}

/**
 * 位置卡片上那一行「详细地址」的文案。
 *
 * 协议里只有 `address`（详细地址）与 `region`（省市区）两个文本字段，**没有**独立
 * 的地点名字段；而一张只写「永外大街车站路12号」的位置卡远不如
 * 「北京南站 · 永外大街车站路12号」有用。所以两边都有时合成一行（用户可以改）。
 */
export function composeLocationAddress(title: string, street: string): string {
  const name = title.trim();
  const detail = street.trim();
  if (!name) return detail;
  if (!detail || name === detail) return name;
  return `${name} · ${detail}`;
}

/**
 * 面板「发送」时交给应用层的载荷。
 *
 * **不含**发送目标：目标是「当前会话」，由 chatPane（`onSendArk(conversation, payload)`）
 * 补上，面板不需要知道自己在私聊还是群聊里。
 */
export type ArkPayload =
  | {
      /** 推荐好友（`kind:'qq'`）/ 推荐群（`kind:'group'`）。 */
      type: 'contact';
      kind: 'qq' | 'group';
      /** 被推荐的好友 QQ 号 / 群号（不是发送目标）。 */
      contactId: number;
      /** 推荐好友时的手机号，可留空。 */
      phoneNumber?: string;
    }
  | {
      /** 位置卡片。 */
      type: 'location';
      address: string;
      region: string;
      latitude: string;
      longitude: string;
    }
  | {
      /**
       * 群报名卡片 —— 走**服务端下发**（OIDB 0x921b_0）。载荷给的是卡片字段，不是一段
       * 拼好的 ark JSON；预览与乐观卡片用的 JSON 由 {@link buildGroupSignupArkJson} 拼。
       */
      type: 'signup';
      /** 目标群号（纯数字）。 */
      groupCode: number;
      title: string;
      detail: string;
      /** 报名截止（unix 秒，UTC）；不填 = 不截止。 */
      deadline?: number;
      /** 报名方式：1 = 直接报名，2 = 上传图片。 */
      method: 1 | 2;
      maxCount: number;
      /** 附带图片直链（可选；method=2 时用）。 */
      imageUrl?: string;
    }
  | {
      /**
       * 图文卡片 —— 走**服务端下发**（OIDB 0xdc2_34），与群反馈的 GitHub
       * issue/PR 卡片是同一条路。载荷给的是卡片四个字段，不是一段拼好的 ark JSON。
       */
      type: 'tuwen';
      /** 跳转链接（必填，http/https）。 */
      jumpUrl: string;
      title: string;
      desc: string;
      /** 预览图；面板已把「留空用默认图」解析好再交上来。 */
      previewUrl: string;
    }
  | {
      /**
       * 任意 ark 卡片 —— 客户端自己拼的那段 ark JSON 编成 `lightApp` 元素发出（走
       * `account.sendArkCard`）。只有「自定义 JSON」那一栏落到这里；图文已改走
       * {@link ArkPayload 的 `tuwen`}，不再自己拼卡。
       */
      type: 'ark';
      arkData: string;
    };

/**
 * 位置卡片 → ark JSON。
 *
 * **只给乐观渲染用**：真正下发走 trpc `LocationArk.SsoSendMessage`，卡片由 QQ 服务端
 * 生成。形状照着 QQ 生成的那张来 —— 渲染器只要在 meta 里看到 `lat`/`lng` 就走静态地图
 * 缩略图那条路（见 components/ark/QqArk.tsx），所以在对方的消息同步回来之前，本机看到的
 * 已经是一张真正的位置卡。
 */
export function buildLocationArkJson(input: {
  address: string;
  region: string;
  latitude: string;
  longitude: string;
}): string {
  return JSON.stringify({
    app: 'com.tencent.map',
    view: 'LocationShare',
    prompt: '[位置]',
    meta: {
      LocationShare: {
        lat: input.latitude.trim(),
        lng: input.longitude.trim(),
        name: input.address.trim(),
        address: input.region.trim(),
      },
    },
  });
}

/**
 * 推荐好友 / 推荐群卡片的**头像** —— QQ 公开 CDN，按号直接拼：
 *
 *   私聊  `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=<uin>`
 *   群聊  `https://p.qlogo.cn/gh/<code>/<code>/0`
 *
 * 与仓库里别处（QqAvatar / 搜索结果卡 / 会话列表）同一个拼法。**不依赖**联系人 / 群
 * 列表是否加载：号给了就能出图，所以面板预览与乐观卡片都能立刻带上头像。
 * （两个域名在 index.html 的 CSP `img-src` 里都已放行；渲染器的 `arkImg` 还会先过
 * `cachedAvatarUrl` 的磁盘缓存。）
 */
export function contactAvatarUrl(kind: 'qq' | 'group', contactId: number): string {
  return kind === 'qq'
    ? `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${contactId}`
    : `https://p.qlogo.cn/gh/${contactId}/${contactId}/0`;
}

/**
 * 推荐好友 / 推荐群的**本地占位卡**。
 *
 * 真卡片由服务端取（0x12b6_0 / 0x8b7_5），拿到 `arkJson` 之前先画一张壳，让「我刚发了
 * 什么」立刻可见；取到卡后原位替换成真的那张（见 MainView 的乐观卡片）。
 *
 * 头像按号拼 CDN 外链（{@link contactAvatarUrl}）—— 昵称 / 群名要服务端才知道，
 * 头像不用，所以这张先画出来的卡也不是个空壳。
 */
export function buildContactPlaceholderArk(kind: 'qq' | 'group', contactId: number): string {
  const title = String(contactId);
  const jumpUrl =
    kind === 'qq'
      ? `mqqapi://card/show_pslcard?src_type=internal&version=1&uin=${contactId}`
      : `mqqapi://card/show_pslcard?src_type=internal&version=1&card_type=group&uin=${contactId}`;
  return JSON.stringify({
    app: kind === 'qq' ? 'com.tencent.contact.lua' : 'com.tencent.troopsharecard',
    view: 'contact',
    prompt: kind === 'qq' ? '[推荐好友]' : '[推荐群聊]',
    meta: {
      contact: {
        title,
        desc: kind === 'qq' ? '推荐好友' : '推荐群聊',
        avatar: contactAvatarUrl(kind, contactId),
        jumpUrl,
      },
    },
  });
}

/**
 * 乐观卡片的**对账签名** —— 真消息同步回来时靠它把乐观条目收掉（见 MainView）。
 *
 * 每种卡片各有一条可靠的不变量：
 *   - 位置卡片：卡片由 QQ 服务端重新生成（文案可能和面板里不一样），但**经纬度是我们
 *     发出去的那两个数** → 用坐标（按 5 位小数归一，`"39.909230"` 与 `"39.90923"`
 *     要是同一张卡）；
 *   - 图文（0xdc2_34 / 带 jumpUrl 的卡片）：卡片同样是服务端出的，JSON 本体逐字比会
 *     永远对不上（字段顺序 / 附加字段都会变），但**跳转链接是我们发出去、也是它下发的
 *     那一条** → 用它；
 *   - 其他（自定义 JSON / 推荐好友 / 推荐群）：发出去的就是这段 JSON、服务端不改写它
 *     → 用 JSON 本体（parse → stringify 消掉缩进差异）。
 */
export function arkCardSignature(arkJson: string): string {
  const raw = typeof arkJson === 'string' ? arkJson.trim() : '';
  if (!raw) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  // 群报名：真卡片由服务端按 0x921b_0 字段生成，字段顺序 / 附加字段都会变，但**标题是
  // 我们发出去、也是它下发的那一条** -> 用标题对账（服务端会重写别的内容）。
  const signupTitle = signupTitleOfArk(parsed);
  if (signupTitle) return `signup:${signupTitle}`;
  const coords = coordinatesOfArk(parsed);
  if (coords) return `loc:${coords}`;
  const jumpUrl = jumpUrlOfArk(parsed);
  if (jumpUrl) return `tuwen:${jumpUrl}`;
  try {
    return `ark:${JSON.stringify(parsed)}`;
  } catch {
    return raw;
  }
}

/** 群报名卡片（`com.tencent.activity.md`）的判据字段 —— 标题。读不到返回 null。 */
function signupTitleOfArk(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  if ((parsed as { app?: unknown }).app !== SIGNUP_ARK_APP) return null;
  const meta = (parsed as { meta?: Record<string, unknown> }).meta;
  if (!meta || typeof meta !== 'object') return null;
  for (const block of Object.values(meta)) {
    if (!block || typeof block !== 'object') continue;
    const title = (block as { title?: unknown }).title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return null;
}

/** 卡片里表示「点击跳转」的字段名（与 components/ark/arkCards.ts 的 `fill('jump', …)` 同序）。 */
const ARK_JUMP_KEYS = ['jumpUrl', 'jump_url', 'qqdocurl', 'url'] as const;

/**
 * 从任意 metaKey 里读出「点击跳转 URL」（图文卡片的对账判据）。
 *
 * 只看 meta 下的各块内容，不看顶层 —— 顶层 `url` 之类字段在别的卡片上有别的含义；
 * 读不到就返回 null（调用方退回 JSON 本体签名）。
 */
function jumpUrlOfArk(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const meta = (parsed as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return null;
  for (const block of Object.values(meta as Record<string, unknown>)) {
    if (!block || typeof block !== 'object') continue;
    for (const key of ARK_JUMP_KEYS) {
      const value = (block as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

/**
 * 推荐好友 / 推荐群 面板里可选的一个条目（应用层注入）。
 *
 * 面板自己**不碰网络**：账号里的好友 / 群列表由应用层查好后交进来，面板只做过滤。
 */
export interface ArkContactEntry {
  /** 发送用的 id：好友 = QQ 号（纯数字），群 = 群号。 */
  id: string;
  /** 主标题：备注优先，其次昵称 / 群名。 */
  name: string;
  /** 副标题：QQ 号 / 群号（+ 群成员数）。 */
  sub?: string;
  /** 头像 URL（拿不到就不画，退回图标）。 */
  avatarUrl?: string;
}

/** 面板用的联系人 / 群候选列表（应用层注入；不传就只有手填号码一条路）。 */
export interface ArkContactSource {
  friends: ArkContactEntry[];
  groups: ArkContactEntry[];
}

/**
 * 十进制数读值：空串 / 缺字段一律 null（`Number('')` 是 0，会把空字段当成真坐标）。
 */
function decimalOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 从任意 metaKey 里读出经纬度（位置卡片的判据），归一成 `lat,lng`。 */
function coordinatesOfArk(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const meta = (parsed as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return null;
  for (const block of Object.values(meta as Record<string, unknown>)) {
    if (!block || typeof block !== 'object') continue;
    const lat = (block as { lat?: unknown }).lat;
    const lng = (block as { lng?: unknown }).lng;
    const latNum = decimalOf(lat);
    const lngNum = decimalOf(lng);
    if (latNum === null || lngNum === null) continue;
    if (latNum === 0 && lngNum === 0) continue;
    return `${latNum.toFixed(5)},${lngNum.toFixed(5)}`;
  }
  return null;
}
