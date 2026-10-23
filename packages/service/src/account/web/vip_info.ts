/**
 * 本账号会员身份 — `club.vip.qq.com/qqvip/api/medal/home/queryUserInfo`。
 *
 * 顶栏昵称后的会员徽标（红 VIP / 金 SVIP / 蓝黑大会员，年费加「年」前缀）
 * 用它拿身份与等级。返回纯 JSON；鉴权是 `vip.qq.com` 域的 p_skey
 * （同一枚票据在 `*.vip.qq.com` 通用，见 friend_dress.ts），csrftoken 走
 * `g_tk = bkn(p_skey)`。
 *
 * ## 字段语义（抓包实测，单账号样本）
 *
 * - `isVip` / `isSvip` / `isBvip`：三档身份。**大会员通常同时 isSvip=true**，
 *   展示时按 bvip > svip > vip 取第一档。
 * - `isVipYear` / `isBvipYear`：年费标记。超会的年费复用了 `isVipYear`
 *   （抓包里 isSvip=true 的账号该字段为 false，说明它不是「SVIP」专属），
 *   大会员另有 `isBvipYear`。**单样本推断，未验证多账号**。
 * - `vipLevel` / `bvipLevel`：对应档位的等级（普通 VIP 没有独立等级字段，
 *   服务端给的是超会等级，故普通 VIP 不展示等级）。
 * - `club_end_timestamp` / `superclub_end_timestamp`：到期时间（unix 秒，
 *   字符串）。`s*ExpireTime` 是同义的中文可读串，仅在数字列缺失时兜底。
 * - `clubStatus`：3 = 会员有效。不单独判它 —— 三档 is* 已经是归一后的结论。
 *
 * 错误约定与其它 cgi 一致：`-3000` / `-10000` 这类「票据不对」抛
 * {@link WebAuthError} 交由 withRetry 换票重试；`data` 缺失按票据失效处理
 * （过期 cookie 的典型表现），其余业务码照常抛 Error。
 */

import type { VipInfo } from '../vip';
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestJson } from './http';

const ENDPOINT = 'https://club.vip.qq.com/qqvip/api/medal/home/queryUserInfo';

/** 票据失效应换票重试的码（与群相册/空间同一套判据）。 */
const AUTH_CODES = new Set([-3000, -10000]);

/** 手 Q Android 的 UA（照 HAR；这个端点认 webview UA）。 */
const VIP_UA =
  'Mozilla/5.0 (Linux; Android 13; 2109119BC Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.71 MQQBrowser/6.2 TBS/047925 Mobile Safari/537.36 V1_AND_SQ_9.2.85_13860_YYB_D QQ/9.2.85.35550 NetType/4G WebP/0.3.0 AppId/537351308 Pixel/1080 StatusBarHeight/95';

/** 会员页；HAR 里还带一串 trace 参数，实测不带也能过，故只留页面本身。 */
const REFERER = 'https://club.vip.qq.com/qqvip/medal/my';

/** 服务端回的原始 `data`（字段类型不统一：bool 与数字列混用）。 */
export interface RawVipUserInfo {
  uin?: number | string;
  clubStatus?: number;
  isVip?: boolean;
  isSvip?: boolean;
  isBvip?: boolean;
  isVipYear?: boolean;
  isBvipYear?: boolean;
  vipLevel?: number | string;
  bvipLevel?: number | string;
  club_end_timestamp?: number | string;
  superclub_end_timestamp?: number | string;
  sVipExpireTime?: string;
  sSVipExpireTime?: string;
  sYearExpireTime?: string;
}

interface RawResponse {
  code?: number;
  data?: RawVipUserInfo;
  message?: string;
}

/** 数字列可能是 string 也可能是 number，缺失/非法 → undefined。 */
function toNum(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * `YYYY-MM-DD HH:mm:ss`（北京时间，服务端不带时区）→ unix 秒。
 * 兼容 `YYYY/MM/DD` 与已带 `T` 的形态；解析失败返回 undefined。
 */
export function parseExpireTime(text: string | undefined): number | undefined {
  const raw = text?.trim();
  if (!raw) return undefined;
  // `2026-11-18 15:52:04` 在 V8 里被当成**本地时区**，而服务端给的是北京时间。
  // 显式拼上 +08:00，免得用户在别的时区看到差几小时的到期日。
  const iso = raw.includes('T') ? raw : raw.replace(/\//g, '-').replace(' ', 'T');
  const withZone = /[+-]\d{2}:?\d{2}$|Z$/.test(iso) ? iso : `${iso}+08:00`;
  const at = Date.parse(withZone);
  return Number.isFinite(at) ? Math.floor(at / 1000) : undefined;
}

/**
 * 原始 `data` → {@link VipInfo}（不是会员时返回 null）。
 *
 * 抽成纯函数便于离线单测：不碰网络、不碰 native。
 */
export function normalizeVipPayload(
  data: RawVipUserInfo | undefined,
  now = Date.now(),
): VipInfo | null {
  if (!data) return null;

  // 大会员优先：它通常同时 isSvip=true，只显示一个徽标，取更高的那档。
  const tier = data.isBvip ? 'bvip' : data.isSvip ? 'svip' : data.isVip ? 'vip' : null;
  if (!tier) return null;

  const level = toNum(tier === 'bvip' ? data.bvipLevel : data.vipLevel) ?? 0;
  // 年费：大会员只看 isBvipYear；超会/普通 VIP 的 isVipYear 是共用的。
  const year = tier === 'bvip' ? data.isBvipYear === true : data.isVipYear === true;

  // 数字列优先（权威），字符串列兜底。大会员取 superclub，其余取 club。
  const numeric =
    tier === 'bvip'
      ? (toNum(data.superclub_end_timestamp) ?? toNum(data.club_end_timestamp))
      : toNum(data.club_end_timestamp);
  const expireAt =
    numeric ??
    (tier === 'bvip'
      ? (parseExpireTime(data.sSVipExpireTime) ?? parseExpireTime(data.sVipExpireTime))
      : parseExpireTime(data.sVipExpireTime));

  return {
    tier,
    year,
    level,
    ...(expireAt !== undefined ? { expireAt } : {}),
    fetchedAt: now,
  };
}

/**
 * 查本账号的会员身份。`cred` 必须是 `vip.qq.com` 域的凭证。
 * 不是会员返回 null（不抛错）；票据失效抛 {@link WebAuthError}。
 */
export async function fetchVipInfo(cred: WebCredential, now = Date.now()): Promise<VipInfo | null> {
  const url = `${ENDPOINT}?g_tk=${computeBkn(cred.pskey)}`;
  const data = await webRequestJson<RawResponse>(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: {
      'User-Agent': VIP_UA,
      Accept: 'application/json; charset=utf-8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'X-Requested-With': 'com.tencent.mobileqq',
      Referer: REFERER,
    },
    retry: WEB_READ_RETRY,
  });

  // `data` 缺失基本就是 cookie 过期（HTTP 仍 200）：换一套票据重试才有意义。
  if (data.code !== 0 || !data.data) {
    const msg = `会员信息查询失败: code=${data.code ?? '?'} ${data.message ?? ''}`.trim();
    throw AUTH_CODES.has(data.code ?? -1) || !data.data
      ? new WebAuthError(msg, data.code)
      : new Error(msg);
  }

  return normalizeVipPayload(data.data, now);
}
