/**
 * QQ 空间**个人**相册读取 —— 相册列表 (`user.qzone.qq.com/proxy/domain/photo.qzone.
 * qq.com/fcgi-bin/fcg_list_album_v3`) 与相册内媒体列表 (`h5.qzone.qq.com/proxy/
 * domain/photo.qzone.qq.com/fcgi-bin/cgi_list_photo`)。
 *
 * 与群相册 (group_album.ts, OIDB 拿媒体) 不同：个人相册的媒体列表走同一套 qzone
 * web cgi，相册 `id` 即媒体列表的 `topicId`。
 *
 * Auth：cookie jar + `g_tk = bkn(p_skey || skey)`（经 pt_login 换票即可，无需注入）。
 * 响应是 `shine0_Callback({…})` 形态的 JSONP —— 走 {@link parseQzoneCallback} 非执行解析。
 *
 * 读路径 throw-on-auth-failure：非零 code 抛错（-3000 / -10000 → WebAuthError 由
 * withRetry 换票重试）；真正的空相册/空媒体返回空数组。
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestText } from './http';
import { parseQzoneCallback } from './qzone';

/**
 * 判定「票据不对」的错误码。-3000 是 QZone 系一贯的登录态失效，-10000 是风控/参数
 * 校验不过(cookie 缺 pt4_token 等风控字段时就是它)。其余错码(无权限、相册不存在)
 * 换票也没用，不该触发重试。
 */
const AUTH_CODES = new Set([-3000, -10000]);

function qzoneCodeError(what: string, code: number, message?: string): Error {
  const msg = `${what} failed: code=${code} ${message ?? ''}`.trim();
  return AUTH_CODES.has(code) ? new WebAuthError(msg, code) : new Error(msg);
}

/** 网页调用用的浏览器 UA（个别 qzone cgi 缺了会拒）。 */
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** 个人相册（归一化形态）。 */
export interface QzoneAlbum {
  /** 相册 id —— 传给媒体列表路径当 `topicId` 用。 */
  id: string;
  /** 相册名。 */
  name: string;
  /** 相册里媒体（照片/视频）总数。 */
  mediaCount: number;
  /** 封面 URL（空相册可能为空）。 */
  coverUrl: string;
  /** 相册描述。 */
  desc: string;
  /** 创建时间 unix 秒。 */
  createTime: number;
  /** 权限位（原样透出；隐私语义以 qzone 页面为准）。 */
  priv: number;
}

interface RawAlbum {
  id?: string | number;
  name?: string;
  total?: number | string;
  pre?: string;
  desc?: string;
  createtime?: number | string;
  priv?: number | string;
}

interface RawAlbumListData {
  albumListModeSort?: RawAlbum[] | null;
  albumsInUser?: RawAlbum[] | null;
}

interface RawAlbumListRet {
  code?: number;
  message?: string;
  data?: RawAlbumListData;
}

/** 归一化一条相册记录。 */
function mapAlbum(a: RawAlbum): QzoneAlbum {
  return {
    id: String(a.id ?? ''),
    name: a.name ?? '',
    mediaCount: Number(a.total ?? 0),
    coverUrl: a.pre ?? '',
    desc: a.desc ?? '',
    createTime: Number(a.createtime ?? 0),
    priv: Number(a.priv ?? 0),
  };
}

/**
 * 列出某 QQ 空间（自己或好友）的相册。`albumListModeSort`（按时间排序）为空时
 * 回退 `albumsInUser`。页面默认取最新一批（pageNumModeSort=40）—— 相册数远超一页
 * 时的深翻页暂未接（个人相册一般远小于该量级）。凭证失效抛 {@link WebAuthError}。
 */
export async function getQzoneAlbumList(
  cred: WebCredential,
  hostUin: string,
): Promise<QzoneAlbum[]> {
  const gtk = computeBkn(cred.pskey || cred.skey);
  const params = new URLSearchParams({
    g_tk: String(gtk),
    t: String(Date.now()),
    hostUin,
    uin: hostUin,
    appid: '4',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    source: 'qzone',
    plat: 'qzone',
    format: 'jsonp',
    notice: '0',
    filter: '1',
    handset: '4',
    pageNumModeSort: '40',
    pageNumModeClass: '15',
    needUserInfo: '1',
    idcNum: '4',
    callbackFun: 'shine0',
  });
  const url = `https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/fcgi-bin/fcg_list_album_v3?${params.toString()}`;
  const text = await webRequestText(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: { Referer: `https://user.qzone.qq.com/${hostUin}`, 'User-Agent': WEB_UA },
  });
  const ret = parseQzoneCallback<RawAlbumListRet>(text);
  if (typeof ret.code === 'number' && ret.code !== 0) {
    throw qzoneCodeError('qzone 相册列表', ret.code, ret.message);
  }
  const data = ret.data;
  const list =
    data?.albumListModeSort && data.albumListModeSort.length > 0
      ? data.albumListModeSort
      : (data?.albumsInUser ?? []);
  return list.map(mapAlbum);
}

// ───────────────────────── 相册内媒体列表 ─────────────────────────

/** 相册内一条媒体（照片/视频，归一化形态）。 */
export interface QzoneAlbumPhoto {
  /** 媒体 id（相册内定位用；部分接口返回原始数字位）。 */
  id: string;
  /** 文件名/标题。 */
  name: string;
  /** 描述。 */
  desc: string;
  /** 原图/视频地址（url 优先，回退封面 pre）。 */
  url: string;
  /** 缩略图地址。 */
  thumbUrl: string;
  /** 上传时间 unix 秒。 */
  uploadTime: number;
  /** 是否视频。 */
  isVideo: boolean;
  /** 视频取 mp4 本体的定位键（lloc/sloc；非视频为空）。 */
  picKey: string;
  width: number;
  height: number;
}

export interface QzoneAlbumMediaResult {
  photos: QzoneAlbumPhoto[];
  /** 相册内媒体总数（服务端 totalInAlbum）。 */
  totalInAlbum: number;
}

interface RawPhoto {
  id?: string | number;
  name?: string;
  desc?: string;
  url?: string;
  pre?: string;
  /** 原图直链（部分接口只有 raw 或 lloc 有完整图）。 */
  raw?: string;
  /** 大图定位键（lloc / sloc），视频取 mp4 本体时当 picKey 用。 */
  lloc?: string;
  sloc?: string;
  uploadtime?: number | string;
  is_video?: boolean | number;
  /** 老接口把视频挂在 phototype='video'（无 is_video）。 */
  phototype?: string;
  video_info?: {
    download_url?: string;
    url1?: string;
    url2?: string;
    url3?: string;
    video_url?: string;
    video_id?: string | number;
    video_time?: string | number;
  };
  width?: number | string;
  height?: number | string;
}

interface RawPhotoListRet {
  code?: number;
  message?: string;
  data?: {
    photoList?: RawPhoto[] | null;
    totalInAlbum?: number | string;
  };
}

/**
 * 列出某相册内媒体（照片/视频）。`topicId` 即相册列表里的 `album.id`。
 * `pageStart`/`pageNum` 支持分页（默认第一页 30 条）。凭证失效抛 WebAuthError。
 */
export async function getQzoneAlbumMedia(
  cred: WebCredential,
  hostUin: string,
  topicId: string,
  pageStart = 0,
  pageNum = 30,
): Promise<QzoneAlbumMediaResult> {
  const gtk = computeBkn(cred.pskey || cred.skey);
  const params = new URLSearchParams({
    g_tk: String(gtk),
    t: String(Date.now()),
    mode: '0',
    idcNum: '4',
    hostUin,
    topicId,
    noTopic: '0',
    uin: hostUin,
    pageStart: String(pageStart),
    pageNum: String(pageNum),
    skipCmtCount: '0',
    singleurl: '1',
    batchId: '',
    notice: '0',
    appid: '4',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    source: 'qzone',
    plat: 'qzone',
    outstyle: 'json',
    format: 'jsonp',
    json_esc: '1',
    question: '',
    answer: '',
    callbackFun: 'shine0',
  });
  const url = `https://h5.qzone.qq.com/proxy/domain/photo.qzone.qq.com/fcgi-bin/cgi_list_photo?${params.toString()}`;
  const text = await webRequestText(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: { Referer: `https://user.qzone.qq.com/${hostUin}`, 'User-Agent': WEB_UA },
  });
  const ret = parseQzoneCallback<RawPhotoListRet>(text);
  if (typeof ret.code === 'number' && ret.code !== 0) {
    throw qzoneCodeError('qzone 相册媒体列表', ret.code, ret.message);
  }
  const data = ret.data;
  const photos = (data?.photoList ?? []).map((p) => ({
    id: String(p.id ?? ''),
    name: p.name ?? '',
    desc: p.desc ?? '',
    url: p.url || p.pre || p.raw || '',
    thumbUrl: p.pre ?? '',
    uploadTime: Number(p.uploadtime ?? 0),
    isVideo: Boolean(p.is_video) || p.phototype === 'video',
    // 视频取 mp4 本体用的定位键（列表 cgi 只给封面，本体要另查）。
    picKey: p.lloc || p.sloc || '',
    width: Number(p.width ?? 0),
    height: Number(p.height ?? 0),
  }));
  return { photos, totalInAlbum: Number(data?.totalInAlbum ?? photos.length) };
}

// ───────────────────────── 视频本体 URL ─────────────────────────
// 相册媒体列表 cgi 只给视频封面（不给本体 mp4）。本体要拿 picKey 再查一次
// `cgi_floatview_photo_list_v2`（相册浮层详情），从 `video_info` 里抠出 mp4。

interface RawFloatviewPhoto {
  picKey?: string;
  lloc?: string;
  is_video?: boolean | number;
  video_info?: RawPhoto['video_info'];
}

interface RawFloatviewRet {
  code?: number;
  message?: string;
  data?: {
    photos?: RawFloatviewPhoto[] | null;
  };
}

/**
 * 查一条相册视频的本体 mp4 URL。`picKey` 即媒体列表里的 `lloc`/`sloc`。
 * 带签名会过期，导出 / 播放前即时取。拿不到 mp4（如只有 m3u8）返回空串。
 * 凭证失效抛 {@link WebAuthError}。
 */
export async function getQzoneAlbumVideoUrl(
  cred: WebCredential,
  hostUin: string,
  topicId: string,
  picKey: string,
): Promise<string> {
  const gtk = computeBkn(cred.pskey || cred.skey);
  const params = new URLSearchParams({
    g_tk: String(gtk),
    t: String(Date.now()),
    topicId,
    picKey,
    shootTime: '',
    cmtOrder: '1',
    fupdate: '1',
    plat: 'qzone',
    source: 'qzone',
    cmtNum: '10',
    likeNum: '5',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    callbackFun: 'viewer',
    offset: '0',
    number: '15',
    uin: hostUin,
    hostUin,
    appid: '4',
    isFirst: '1',
    sortOrder: '1',
    showMode: '1',
    need_private_comment: '1',
    prevNum: '9',
    postNum: '18',
  });
  const url = `https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/fcgi-bin/cgi_floatview_photo_list_v2?${params.toString()}`;
  const text = await webRequestText(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: { Referer: `https://user.qzone.qq.com/${hostUin}`, 'User-Agent': WEB_UA },
  });
  const ret = parseQzoneCallback<RawFloatviewRet>(text);
  if (typeof ret.code === 'number' && ret.code !== 0) {
    throw qzoneCodeError('qzone 相册视频详情', ret.code, ret.message);
  }
  const photo = (ret.data?.photos ?? []).find(
    (p) => p.picKey === picKey || p.lloc === picKey || p.is_video || p.video_info,
  );
  const vi = photo?.video_info;
  // mp4 本体：download_url 是新接口形态，url3 是旧接口形态；video_url 是 m3u8
  // （Chromium 不能直接播），一律不取。
  return vi?.download_url || vi?.url3 || '';
}
