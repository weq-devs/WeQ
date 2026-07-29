/**
 * 群相册列表查询 — `h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/
 * qun_list_album_v2` (cmd=qunGetAlbumList).
 *
 * This is the qzone HTTP cgi for *listing albums only*. Listing the media inside
 * an album is a separate trpc/OIDB path and is intentionally NOT handled here.
 *
 * Auth: cookie jar + `g_tk = bkn(p_skey || skey)`. `uin` goes in the query bare
 * (no 'o' prefix), while the cookie's uin keeps the 'o'.
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestJson } from './http';

export interface GroupAlbum {
  /** Album id — pass to the (OIDB) media-list path to enumerate contents. */
  id: string;
  /** Album name. */
  title: string;
  /** Number of photos in the album. */
  photoCount: number;
  /** Cover thumbnail URL (may be empty for an empty album). */
  coverUrl: string;
  /** Album description (the cgi pads empty descriptions with a space). */
  desc: string;
  /** Creator uin. */
  createUin: number;
  /** Creator display name at creation time. */
  createNickname: string;
  /** Creation time, the cgi's formatted local string e.g. "2026-05-14 05:28:58". */
  createTime: string;
  /** Last-update time, same format as {@link createTime}. */
  updateTime: string;
}

interface RawAlbum {
  id?: string;
  title?: string;
  photocnt?: number;
  coverurl?: string;
  desc?: string;
  createuin?: number;
  createnickname?: string;
  createtime?: string;
  updatetime?: string;
}

interface RawAlbumListRet {
  code?: number;
  message?: string;
  data?: { album?: RawAlbum[] | null };
}

/**
 * 判定「票据不对」的错误码。-3000 是 QZone 系一贯的登录态失效,-10000 是风控/参数
 * 校验不过(cookie 缺 pt4_token 等风控字段时就是它)。其余错码(无权限、群不存在)
 * 换票也没用,不该触发重试。
 */
const AUTH_CODES = new Set([-3000, -10000]);

/**
 * List a group's photo albums. Returns `[]` when the group has none.
 *
 * 凭证失效时抛 {@link WebAuthError} 而不是返回空数组 —— 见函数体里的说明。
 */
export async function getGroupAlbumList(
  cred: WebCredential,
  groupId: string,
): Promise<GroupAlbum[]> {
  const gtk = computeBkn(cred.pskey || cred.skey);

  const params = new URLSearchParams({
    random: '7570',
    g_tk: String(gtk),
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    qua: 'V1_IPH_SQ_6.2.0_0_HDBM_T',
    cmd: 'qunGetAlbumList',
    qunId: groupId,
    qunid: groupId,
    start: '0',
    num: '1000',
    uin: cred.uin,
    getMemberRole: '0',
  });
  const url = `https://h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/qun_list_album_v2?${params.toString()}`;

  const ret = await webRequestJson<RawAlbumListRet>(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
  });

  // 票据过期时这支 cgi 回的是 **HTTP 200** 加一个错误码,不检查的话空相册和
  // 「cookie 失效」长得一模一样 —— 用户看到的是「这个群没有相册」,而不是让上层
  // 有机会换票重试。凭证类的错码单独抛 WebAuthError,由 withRetry 接住。
  if (typeof ret.code === 'number' && ret.code !== 0) {
    const msg = `群相册列表失败: code=${ret.code} ${ret.message ?? ''}`.trim();
    throw AUTH_CODES.has(ret.code) ? new WebAuthError(msg, ret.code) : new Error(msg);
  }

  const albums = ret.data?.album ?? [];
  return albums.map((a) => ({
    id: a.id ?? '',
    title: a.title ?? '',
    photoCount: a.photocnt ?? 0,
    coverUrl: a.coverurl ?? '',
    desc: a.desc ?? '',
    createUin: a.createuin ?? 0,
    createNickname: a.createnickname ?? '',
    createTime: a.createtime ?? '',
    updateTime: a.updatetime ?? '',
  }));
}
