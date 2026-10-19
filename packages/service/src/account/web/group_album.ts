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
import { WEB_READ_RETRY, webRequestJson } from './http';
import { createHash } from 'node:crypto';

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
    retry: WEB_READ_RETRY,
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

// ───────────────────────── 写操作：上传图片 ─────────────────────────

/** 单次分片大小（与官方 h5 上传一致）。 */
const ALBUM_SLICE_SIZE = 16 * 1024;

interface AlbumSliceSessionResponse {
  ret?: number;
  msg?: string;
  data?: { session?: string; slice_size?: number };
}

function albumUploadCookie(cred: WebCredential): string {
  // 上传 CGI 只认这四个字段；用整份 jar 反而会带上别域的同名 cookie。
  return `p_uin=o${cred.uin}; p_skey=${cred.pskey}; skey=${cred.skey}; uin=o${cred.uin}`;
}

/** 上传用的 g_tk 只由 skey 推导（与官方 h5 一致）。 */
function albumUploadGtk(cred: WebCredential): number {
  return computeBkn(cred.skey);
}

export interface UploadGroupAlbumImageParams {
  groupId: string;
  albumId: string;
  albumName: string;
  /** 图片字节（JPEG / PNG / GIF / WebP / BMP）。 */
  image: Uint8Array;
  /** 相册内显示的文件名。 */
  fileName?: string;
  /** 可选取消信号。 */
  signal?: AbortSignal;
}

/**
 * 上传一张图片到群相册。
 *
 * 两步：`FileBatchControl/{md5}` 建会话 → 16 KiB 分片 `FileUpload`。
 * 搬运自 SnowLuma `protocol/src/web/group-album.ts`。
 *
 * 写操作**不做自动重试**（重放分片可能产生重复照片），失败原样上抛。
 */
export async function uploadGroupAlbumImage(
  cred: WebCredential,
  params: UploadGroupAlbumImageParams,
): Promise<{ session: string }> {
  const { image } = params;
  if (!(image instanceof Uint8Array) || image.length === 0) {
    throw new Error('相册图片不能为空');
  }
  if (!params.groupId) throw new Error('groupId 不能为空');
  if (!params.albumId) throw new Error('albumId 不能为空');

  const md5 = createHash('md5').update(Buffer.from(image)).digest('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const fileName = params.fileName?.trim() || `image_${timestamp}.jpg`;
  const gtk = albumUploadGtk(cred);
  const cookie = albumUploadCookie(cred);

  // 1. 建上传会话。
  const controlBody = {
    control_req: [
      {
        uin: cred.uin,
        token: { type: 4, data: cred.pskey, appid: 5 },
        appid: 'qun',
        checksum: md5,
        check_type: 0,
        file_len: image.length,
        env: { refer: 'qzone', deviceInfo: 'h5' },
        model: 0,
        biz_req: {
          sPicTitle: fileName,
          sPicDesc: '',
          sAlbumName: params.albumName,
          sAlbumID: params.albumId,
          iAlbumTypeID: 0,
          iBitmap: 0,
          iUploadType: 0,
          iUpPicType: 0,
          iBatchID: timestamp,
          sPicPath: '',
          iPicWidth: 0,
          iPicHight: 0,
          iWaterType: 0,
          iDistinctUse: 0,
          iNeedFeeds: 1,
          iUploadTime: timestamp,
          mapExt: { appid: 'qun', userid: params.groupId },
          stExtendInfo: { mapParams: { photo_num: '1', video_num: '0', batch_num: '1' } },
        },
        session: '',
        asy_upload: 0,
        cmd: 'FileUpload',
      },
    ],
  };
  const controlUrl = `https://h5.qzone.qq.com/webapp/json/sliceUpload/FileBatchControl/${md5}?g_tk=${gtk}`;
  const control = await webRequestJson<AlbumSliceSessionResponse>(controlUrl, {
    method: 'POST',
    cookie,
    body: JSON.stringify(controlBody),
    headers: { 'Content-Type': 'application/json' },
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const session = control.data?.session;
  if (control.ret !== 0 || !session) {
    throw new Error(
      `创建相册上传会话失败：ret=${control.ret ?? 'missing'} ${control.msg ?? ''}`.trim(),
    );
  }

  // 2. 分片上传。
  const sliceSize =
    control.data?.slice_size && control.data.slice_size > 0
      ? control.data.slice_size
      : ALBUM_SLICE_SIZE;
  for (let offset = 0, seq = 0; offset < image.length; offset += sliceSize, seq += 1) {
    params.signal?.throwIfAborted();
    const chunk = image.subarray(offset, Math.min(offset + sliceSize, image.length));
    const end = offset + chunk.length;
    const boundary = `----WeQAlbum${Date.now()}${seq}`;
    const field = (name: string, value: string): string =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const head = Buffer.from(
      field('uin', cred.uin) +
        field('appid', 'qun') +
        field('session', session) +
        field('offset', String(offset)) +
        `--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = Buffer.from(
      '\r\n' +
        field('checksum', '') +
        field('check_type', '0') +
        field('retry', '0') +
        field('seq', String(seq)) +
        field('end', String(end)) +
        field('cmd', 'FileUpload') +
        field('slice_size', String(sliceSize)) +
        field('biz_req.iUploadType', '0') +
        `--${boundary}--\r\n`,
    );
    const body = new Uint8Array(head.length + chunk.length + tail.length);
    body.set(head, 0);
    body.set(chunk, head.length);
    body.set(tail, head.length + chunk.length);

    const url =
      `https://h5.qzone.qq.com/webapp/json/sliceUpload/FileUpload` +
      `?seq=${seq}&retry=0&offset=${offset}&end=${end}&total=${image.length}&type=form&g_tk=${gtk}`;
    const ret = await webRequestJson<{ ret?: number; msg?: string }>(url, {
      method: 'POST',
      cookie,
      body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (ret.ret !== 0) {
      throw new Error(
        `相册分片 ${seq} 上传失败：ret=${ret.ret ?? 'missing'} ${ret.msg ?? ''}`.trim(),
      );
    }
  }
  return { session };
}
