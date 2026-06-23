/**
 * 群公告查询 — `web.qun.qq.com/cgi-bin/announce/list_announce`.
 *
 * The cgi wants TWO bkns: the URL carries bkn(p_skey) and the POST body carries
 * bkn(skey). (Naming in the wild is inconsistent; this split is what actually
 * authenticates.) Response is `{ ec, feeds: { <fid>: feed } }`.
 */

import { computeBkn, cookieHeader, type WebCredential } from './credential';
import { webRequestJson } from './http';

export interface GroupNoticeImage {
  id: string;
  width: number;
  height: number;
}

export interface GroupNotice {
  /** Feed id (`fid`) — stable handle for the announcement. */
  noticeId: string;
  /** Publisher uin. */
  senderId: number;
  /** Publish time, unix seconds. */
  publishTime: number;
  text: string;
  images: GroupNoticeImage[];
  /** How many members have read it. */
  readNum: number;
}

interface RawNoticeFeed {
  fid: string;
  u: number;
  pubt: number;
  msg?: { text?: string; pics?: Array<{ id: string; w: number; h: number }> };
  read_num?: number;
}

interface RawNoticeRet {
  ec: number;
  em?: string;
  feeds?: Record<string, RawNoticeFeed>;
}

/**
 * Fetch a group's announcements. `start = -1` is the first page; `count` is the
 * page size. Returns `[]` when the cgi reports an error (expired cookie / no
 * permission) or the group has none.
 */
export async function getGroupNotice(
  cred: WebCredential,
  groupCode: string,
  start = -1,
  count = 20,
): Promise<GroupNotice[]> {
  const urlBkn = computeBkn(cred.pskey || cred.skey);
  const bodyBkn = computeBkn(cred.skey);

  const url = `https://web.qun.qq.com/cgi-bin/announce/list_announce?bkn=${urlBkn}`;
  const body = new URLSearchParams({
    qid: groupCode,
    bkn: String(bodyBkn),
    ft: '23',
    s: String(start),
    n: String(count),
    i: '1',
    ni: '1',
  }).toString();

  const ret = await webRequestJson<RawNoticeRet>(url, {
    method: 'POST',
    cookie: cookieHeader(cred),
    body,
    headers: { Referer: 'https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148' },
  });

  if (ret.ec !== 0 || !ret.feeds) return [];

  return Object.values(ret.feeds).map((feed) => ({
    noticeId: feed.fid,
    senderId: feed.u,
    publishTime: feed.pubt,
    text: feed.msg?.text ?? '',
    images: (feed.msg?.pics ?? []).map((p) => ({ id: p.id, width: p.w, height: p.h })),
    readNum: feed.read_num ?? 0,
  }));
}
