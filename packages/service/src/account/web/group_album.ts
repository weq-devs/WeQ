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

import { computeBkn, cookieHeader, type WebCredential } from './credential';
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
 * List a group's photo albums. Returns `[]` when the group has none or the
 * response carries no album array.
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
