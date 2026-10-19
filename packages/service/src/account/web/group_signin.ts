/**
 * 群打卡列表 — `qun.qq.com/v2/signin/trpc/GetDaySignedList`。
 *
 * 搬运自 SnowLuma `protocol/src/web/group-signin.ts`。
 * 与 NapCat `get_group_signed_list` 同源（NapCat 直接把这个响应映射成 OneBot 形状）。
 *
 * 认证：`g_tk = bkn(p_skey || skey)`，cookie 用 `qun.qq.com` 的全量 jar。
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestJson } from './http';

interface RawDaySignedInfo {
  uid?: string;
  uidGroupNick?: string;
  signedTimeStamp?: string;
  signInRank?: number;
}

interface RawDaySignedPage {
  infos?: RawDaySignedInfo[];
  offset?: number;
  total?: number;
}

interface RawDaySignedList {
  retCode?: number;
  funcCode?: number;
  response?: {
    ret?: { code?: string; msg?: string };
    page?: RawDaySignedPage[];
  };
}

export interface SignedListMember {
  /** 打卡者 QQ 号。 */
  userId: number;
  nick: string;
  /** 打卡时间（unix 秒）。 */
  time: number;
  /** 人类可读的 1-based 名次。 */
  rank: number;
}

export interface FetchDaySignedListParams {
  groupId: string;
  /** `YYYYMMDD`；缺省用本地时区的今天。 */
  dayYmd?: string;
  offset?: number;
  limit?: number;
}

/** `YYYYMMDD`（本地时区），endpoint 要的形式。 */
export function dayYmd(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * 纯映射：服务端 `signInRank` 是「翻倍并偏移」的刻度（1,3,5,…），
 * 官方客户端用 `(rank - 1) / 2 + 1` 还原成 1-based 名次。
 *
 * `page/infos` 缺失返回空数组（当天无人打卡），而不是报错。
 */
export function mapDaySignedList(data: RawDaySignedList): SignedListMember[] {
  const infos = data.response?.page?.[0]?.infos;
  if (!infos) return [];
  return infos.map((info) => ({
    userId: Number(info.uid ?? 0),
    nick: info.uidGroupNick ?? '',
    time: Number(info.signedTimeStamp ?? 0),
    rank: (Number(info.signInRank ?? 0) - 1) / 2 + 1,
  }));
}

export async function fetchDaySignedList(
  cred: WebCredential,
  params: FetchDaySignedListParams,
): Promise<SignedListMember[]> {
  const groupId = String(params.groupId ?? '').trim();
  if (!groupId) throw new Error('groupId 不能为空');
  const bkn = computeBkn(cred.pskey || cred.skey);
  const url = `https://qun.qq.com/v2/signin/trpc/GetDaySignedList?g_tk=${bkn}`;
  const body = JSON.stringify({
    dayYmd: params.dayYmd ?? dayYmd(),
    offset: params.offset ?? 0,
    limit: params.limit ?? 100,
    uid: cred.uin,
    groupId,
  });

  const ret = await webRequestJson<RawDaySignedList>(url, {
    method: 'POST',
    cookie: cookieHeader(cred),
    body,
    headers: {
      'Content-Type': 'application/json',
      Referer: `https://qun.qq.com/`,
    },
  });

  // `page` 缺失通常意味着票据/权限问题（不是「没人打卡」），如实报错。
  if (!ret.response?.page) {
    const msg = ret.response?.ret?.msg ?? `retCode=${ret.retCode ?? 'unknown'}`;
    throw new WebAuthError(`获取群打卡列表失败：${msg}`, ret.retCode ?? -1);
  }
  return mapDaySignedList(ret);
}
