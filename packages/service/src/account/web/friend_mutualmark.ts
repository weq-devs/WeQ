/**
 * 好友互动标识(任务进度 / 关系标识) — `ti.qq.com/.../friends_mutualmark/aggregate/home/get`.
 *
 * 返回的是 JSON(非 SSR 页面):某好友与你之间的互动标识聚合页数据,含任务标识
 * (友谊的小船/巨轮、畅聊之火、闺蜜/基友/死党…)、惊喜标识、幸运字符三大类,每类里
 * 每个标识带当前等级/进度计数/已点亮天数/是否佩戴/图标等。我们只发 GET、带 skey
 * 域凭证,并把服务端给的信息收进结构化模型。
 *
 * Auth: cookie 四字段(uin/skey/p_uin/p_skey,`ti.qq.com` 域)+ query 里的
 * `bkn = bkn(skey)`(实测 p_skey 算出来的 bkn 不对,见 task.har)。风控 cookie
 * (a2/domain_id 等)由 ptlogin2 jar 带上,非必需 —— 拿不到时 4 字段也能过。
 *
 * 错误约定:retcode 非 0 时,-3000/-10000 这类「票据不对」抛 WebAuthError 交由
 * withRetry 换票重试;其余(无权限/参数错)照常抛 Error。
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestJson } from './http';

/** 某个等级的达成条件(服务端 `info.graded[]`)。 */
export interface FriendMarkLevel {
  /** 等级序号(1 起)。 */
  level: number;
  /** 等级展示名,如「友谊的小船」「友谊的巨轮」。 */
  name: string;
  /** 达成该等级的阈值(天数/次数等,单位随标识而异)。 */
  threshold: number;
  /** 达成描述。 */
  desc: string;
}

/** 一个互动标识的当前状态(服务端 `status` + `info` 合并)。 */
export interface FriendMark {
  /** 标识 id。 */
  id: string;
  /** 当前等级的展示名(未点亮时取首个可达成等级名,再不行回落到简介)。 */
  name: string;
  /** 简介(任务说明),如「好友互发消息」。 */
  intro: string;
  /** 稳定符号(boat/fire/confidante/spray…),可用于跨版本识别。 */
  symbol: string;
  /** 稀有度(0 普通,越大越稀有)。 */
  rarity: number;
  /** 当前等级(0 = 未点亮)。 */
  level: number;
  /** 当前等级的目标阈值。 */
  threshold: number;
  /** 下一等级展示名(已满级则 undefined)。 */
  nextLevelName?: string;
  /** 全部等级(服务端 `info.graded[]`,按等级升序);无分级数据时为空数组。 */
  levels: FriendMarkLevel[];
  /** 进度计数(如互发消息数/绑定天数),单位随标识而异。 */
  count: number;
  /** 累计天数(act_days)。 */
  actDays: number;
  /** 已点亮天数。 */
  lightupDays: number;
  /** 当前图标 url(等级/状态对应的那张)。 */
  iconUrl: string;
  /** 图标模板(含 {level}_{sub_level} 占位,可拼任意等级)。 */
  iconFormat: string;
  /** 是否已点亮。 */
  isLightup: boolean;
  /** 对方(或我)是否正佩戴。 */
  isWearing: boolean;
  /** 是否处于降级状态。 */
  isDegrade: boolean;
  /** 是否为新获得。 */
  isNew: boolean;
}

/** 一个标识分类(任务标识 / 惊喜标识 / 幸运字符)。 */
export interface FriendMarkCategory {
  /** 分类 id(1=任务标识,2=惊喜标识,special_word=幸运字符)。 */
  id: string;
  name: string;
  /** 该分类已点亮数。 */
  lightUpNum: number;
  /** 该分类标识总数。 */
  totalNum: number;
  marks: FriendMark[];
}

export interface FriendMutualMark {
  /** 被查询的好友。 */
  targetUin: string;
  targetNickname: string;
  /** 好友备注名(没备注时与 nickname 同值)。 */
  targetRemark: string;
  targetHeadUrl: string;
  /** 本账号(查询方)。 */
  selfUin: string;
  selfNickname: string;
  /** 全量统计。 */
  totalNum: number;
  lightUpNum: number;
  rarityNum: number;
  rarityLightUpNum: number;
  categories: FriendMarkCategory[];
}

/** 判定「票据不对」的错误码 —— 与群相册/qzone 同一套判据。 */
const AUTH_CODES = new Set([-3000, -10000]);

/** 手 Q Android webview 的 UA(照 task.har;桌面 UA 可能返回不同壳)。 */
const TI_UA =
  'Mozilla/5.0 (Linux; Android 13; 2109119BC Build/TKQ1.221114.001; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36 ' +
  'V1_AND_SQ_9.2.95_14200_YYB_D QQ/9.2.95.36400 NetType/WIFI WebP/0.4.1 AppId/537357472 ' +
  'Pixel/1080 StatusBarHeight/95 SimpleUISwitch/0 QQTheme/1000 QQExt/0 StudyMode/0 ' +
  'CurrentMode/0 CurrentFontScale/1.0 GlobalDensityScale/0.9818182 AllowLandscape/false InMagicWin/0';

const ENDPOINT = 'https://ti.qq.com/interactive_new/cgi-bin/friends_mutualmark/aggregate/home/get';

interface RawGraded {
  level?: string;
  name?: string;
  threshold?: string;
  desc?: string;
}

interface RawMarkInfo {
  id?: string;
  intro?: string;
  rarity?: number;
  icon_format?: string;
  symbol?: string;
  graded?: RawGraded[];
}

interface RawMarkStatus {
  id?: string;
  level?: string;
  count?: number | string;
  act_days?: number | string;
  lightup_days?: number | string;
  icon_url?: string;
  is_wearing?: boolean;
  is_lightup?: boolean;
  is_degrade?: boolean;
  is_new?: boolean;
}

interface RawMark {
  info?: RawMarkInfo;
  status?: RawMarkStatus;
}

interface RawCategory {
  id?: string;
  name?: string;
  light_up_num?: number;
  total_num?: number;
  mutual_mark_state_list?: RawMark[];
}

interface RawUser {
  uin?: string;
  nickname?: string;
  remark_name?: string;
  head_url?: string;
}

interface RawData {
  user_info?: RawUser;
  frd_user_info?: RawUser;
  num?: number;
  rarity_num?: number;
  light_up_num?: number;
  rarity_light_up_num?: number;
  category_list?: RawCategory[];
}

interface RawResponse {
  retcode?: number;
  msg?: string;
  data?: RawData;
}

/** 数值字段可能是 string 也可能是 number,统一收成 number(缺失/非法 → 0)。 */
function toNum(v: number | string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 服务端 `info.graded[]` → 有序等级表(按等级升序,剔除非法序号)。 */
function toLevels(info: RawMarkInfo): FriendMarkLevel[] {
  return (info.graded ?? [])
    .map((g) => ({
      level: toNum(g.level),
      name: g.name ?? '',
      threshold: toNum(g.threshold),
      desc: g.desc ?? '',
    }))
    .filter((l) => l.level > 0)
    .sort((a, b) => a.level - b.level);
}

/** 取当前等级(及下一级)的展示信息。 */
function resolveLevel(
  levels: FriendMarkLevel[],
  intro: string,
  level: number,
): {
  name: string;
  threshold: number;
  nextLevelName?: string;
} {
  const current = levels.find((l) => l.level === level) ?? levels[0];
  const next = levels.find((l) => l.level > level);
  return {
    name: current?.name || intro || '',
    threshold: current?.threshold ?? 0,
    nextLevelName: next?.name,
  };
}

function toMark(r: RawMark): FriendMark {
  const info = r.info ?? {};
  const status = r.status ?? {};
  const level = toNum(status.level);
  const levels = toLevels(info);
  const { name, threshold, nextLevelName } = resolveLevel(levels, info.intro ?? '', level);
  return {
    id: info.id ?? status.id ?? '',
    name,
    intro: info.intro ?? '',
    symbol: info.symbol ?? '',
    rarity: info.rarity ?? 0,
    level,
    threshold,
    nextLevelName,
    levels,
    count: toNum(status.count),
    actDays: toNum(status.act_days),
    lightupDays: toNum(status.lightup_days),
    iconUrl: status.icon_url ?? info.icon_format ?? '',
    iconFormat: info.icon_format ?? '',
    isLightup: status.is_lightup ?? false,
    isWearing: status.is_wearing ?? false,
    isDegrade: status.is_degrade ?? false,
    isNew: status.is_new ?? false,
  };
}

function toUser(u: RawUser | undefined): {
  uin: string;
  nickname: string;
  remark: string;
  headUrl: string;
} {
  return {
    uin: u?.uin ?? '',
    nickname: u?.nickname ?? '',
    remark: u?.remark_name ?? u?.nickname ?? '',
    headUrl: u?.head_url ?? '',
  };
}

/**
 * 查 `targetUin` 与你之间的互动标识(任务进度/关系标识)。凭证失效时抛
 * {@link WebAuthError} 由上层 withRetry 换票重试;接口 retcode 非 0 抛错。
 */
export async function getFriendMutualMark(
  cred: WebCredential,
  targetUin: string,
): Promise<FriendMutualMark> {
  const params = new URLSearchParams({
    frd_uin: targetUin,
    version: '9.2.95',
    // bkn 由 skey 算(实测 p_skey 不对)。
    bkn: String(computeBkn(cred.skey)),
  });
  const url = `${ENDPOINT}?${params.toString()}`;

  const data = await webRequestJson<RawResponse>(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: {
      'User-Agent': TI_UA,
      Accept: 'application/json; charset=utf-8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'X-Requested-With': 'com.tencent.mobileqq',
      Referer: `https://ti.qq.com/interactive_new/index/?source=0&_wv=67108867&_nav_txtclr=000000&_wvSb=0&target_uin=${targetUin}&has_show_guid=0`,
    },
  });

  if (data.retcode !== 0) {
    const msg = `好友互动标识失败: retcode=${data.retcode ?? '?'} ${data.msg ?? ''}`.trim();
    throw AUTH_CODES.has(data.retcode ?? -1) ? new WebAuthError(msg, data.retcode) : new Error(msg);
  }

  const d = data.data ?? {};
  const self = toUser(d.user_info);
  const frd = toUser(d.frd_user_info);

  return {
    targetUin: frd.uin || targetUin,
    targetNickname: frd.nickname,
    targetRemark: frd.remark,
    targetHeadUrl: frd.headUrl,
    selfUin: self.uin,
    selfNickname: self.nickname,
    totalNum: d.num ?? 0,
    lightUpNum: d.light_up_num ?? 0,
    rarityNum: d.rarity_num ?? 0,
    rarityLightUpNum: d.rarity_light_up_num ?? 0,
    categories: (d.category_list ?? []).map((c) => ({
      id: c.id ?? '',
      name: c.name ?? '',
      lightUpNum: c.light_up_num ?? 0,
      totalNum: c.total_num ?? 0,
      marks: (c.mutual_mark_state_list ?? []).map(toMark),
    })),
  };
}
