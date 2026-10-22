import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestJson } from './http';

export interface GroupAlbumFeedRequest {
  groupCode: string;
  albumId: string;
  batchId: string;
  legacyFocus?: string;
  cursor?: string;
}
export interface GroupAlbumFeedComment {
  id: string;
  content: string;
  time: number | null;
  author: { uin: string; name: string };
  replies: GroupAlbumFeedComment[];
  totalReplies: number | null;
}
export interface GroupAlbumFeedPage {
  groupCode: string;
  albumId: string;
  albumName: string;
  batchId: string;
  author: { uin: string; name: string };
  time: number | null;
  media: Array<{
    id: string;
    kind: 'image' | 'video';
    url: string;
    previewUrl: string;
    width: number | null;
    height: number | null;
  }>;
  comments: GroupAlbumFeedComment[];
  totalComments: number | null;
  totalMedia: number | null;
  hasMore: boolean | null;
  nextCursor: string | null;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  return record(value) ? value : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function id(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function author(value: unknown) {
  const user = object(value);
  return { uin: id(user.uin), name: text(user.nickname) };
}
function url(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.startsWith('//') ? `https:${value}` : value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}
function comments(value: unknown, reply = false): GroupAlbumFeedComment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 1000) throw new Error('群相册评论列表无效');
  return value.map((item) => {
    if (
      !record(item) ||
      !id(item[reply ? 'replyid' : 'commentid']) ||
      typeof item.content !== 'string'
    )
      throw new Error('群相册评论记录无效');
    return {
      id: id(item[reply ? 'replyid' : 'commentid']),
      content: item.content,
      time: count(item.date),
      author: author(item.user),
      replies: reply ? [] : comments(item.replys, true),
      totalReplies: reply ? 0 : count(item.replynum),
    };
  });
}
function validate(request: GroupAlbumFeedRequest) {
  if (
    typeof request.groupCode !== 'string' ||
    !/^[1-9]\d{4,19}$/.test(request.groupCode) ||
    typeof request.albumId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,256}$/.test(request.albumId) ||
    typeof request.batchId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(request.batchId) ||
    (request.legacyFocus !== undefined &&
      (typeof request.legacyFocus !== 'string' ||
        !/^[\x21-\x7e]{1,512}$/.test(request.legacyFocus))) ||
    (request.cursor !== undefined &&
      (typeof request.cursor !== 'string' || request.cursor.length > 16384))
  )
    throw new Error('群相册动态目标或分页无效');
}

/** 官方移动页使用的原始 cell 槽位；不能将缺失详情当成空相册或空评论。 */
export function parseGroupAlbumFeed(
  raw: unknown,
  request: GroupAlbumFeedRequest,
): GroupAlbumFeedPage {
  validate(request);
  if (!record(raw) || typeof raw.ret !== 'number' || !Number.isSafeInteger(raw.ret))
    throw new Error('群相册动态缺少明确业务回执');
  if (raw.ret !== 0) {
    const message = `群相册动态读取失败：code=${raw.ret}`;
    if ([-3000, -10000].includes(raw.ret)) throw new WebAuthError(message, raw.ret);
    throw new Error(message);
  }
  const data = object(raw.data),
    detail = object(data.detail_data).singledetail;
  if (!detail || typeof detail !== 'object') throw new Error('群相册动态不存在或未返回详情');
  const cells = detail as Record<string, unknown>;
  const common = object(cells['0']),
    user = object(cells['1']),
    content = object(cells['2']),
    media = object(cells['5']),
    discussion = object(cells['10']);
  // 旧定位视图的文本 subid 不再是批次，父批次由操作 cell 的 busi_param.21 明确返回。
  const operation = object(object(cells['18']).busi_param);
  const parentBatch = Object.hasOwn(operation, '21') ? id(operation['21']) : id(content.subid);
  if (
    id(media.qunid) !== request.groupCode ||
    id(media.albumid) !== request.albumId ||
    parentBatch !== request.batchId
  )
    throw new Error('群相册动态的群号、相册或批次不一致');
  const pictures = media.picdata;
  if (!Array.isArray(pictures) || pictures.length > 1000) throw new Error('群相册动态媒体列表无效');
  const hasMore =
    data.hasmore === 1 || data.hasmore === true
      ? true
      : data.hasmore === 0 || data.hasmore === false
        ? false
        : null;
  const nextCursor = text(data.attach_info) || null;
  if (hasMore && (!nextCursor || nextCursor === request.cursor))
    throw new Error('群相册动态未提供可继续的分页位置');
  const mediaIds = new Set<string>();
  const commentRows = comments(discussion.commments);
  const mainComment = object(discussion.main_comment),
    mainId = id(mainComment.commentid);
  if (mainId && mainId !== '0' && !commentRows.some((row) => row.id === mainId))
    commentRows.unshift(...comments([mainComment]));
  return {
    groupCode: request.groupCode,
    albumId: request.albumId,
    albumName: text(media.albumname),
    batchId: request.batchId,
    author: author(user.user),
    time: count(common.time),
    media: pictures.map((picture) => {
      if (!record(picture) || !id(picture.lloc) || mediaIds.has(id(picture.lloc)))
        throw new Error('群相册动态媒体身份无效');
      mediaIds.add(id(picture.lloc));
      const videoFlag = picture.videoflag;
      if (
        videoFlag !== undefined &&
        videoFlag !== 0 &&
        videoFlag !== 1 &&
        videoFlag !== false &&
        videoFlag !== true
      )
        throw new Error('群相册动态媒体类型未知');
      const sizes = object(picture.photourl),
        image = object(sizes['1'] ?? sizes['11'] ?? sizes['2'] ?? sizes['3']),
        video = object(picture.videodata);
      const isVideo = videoFlag === 1 || videoFlag === true;
      return {
        id: id(picture.lloc),
        kind: isVideo ? 'video' : 'image',
        url: isVideo ? url(video.videourl) : url(image.url),
        previewUrl: url(image.url),
        width: count(image.width),
        height: count(image.height),
      };
    }),
    comments: commentRows,
    totalComments: count(discussion.num),
    totalMedia: count(media.uploadnum),
    hasMore,
    nextCursor: hasMore ? nextCursor : null,
  };
}

/** GET 仅读取。保留旧定位串交服务端解释，不在客户端猜评论／图片身份。 */
export function groupAlbumFeedRequestUrl(
  cred: WebCredential,
  request: GroupAlbumFeedRequest,
): string {
  validate(request);
  const legacy = new URL('https://mobile.qzone.qq.com/photo/group/batch');
  legacy.search = new URLSearchParams({
    i: request.albumId,
    u: request.groupCode,
    p: request.batchId,
    a: '422',
    v: '2',
    cmd: '2',
    ...(request.legacyFocus ? { f: request.legacyFocus } : {}),
  }).toString();
  const params = new URLSearchParams({
    cmd: 'qunGetDetail',
    uin: cred.uin,
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    'mqqinfo.cell_operation.qq_url': legacy.href,
    refresh_type: request.cursor ? '2' : '7',
    attach_info: request.cursor ?? '',
  });
  return `https://h5.qzone.qq.com/groupphoto/inqq?${params}`;
}

export async function getGroupAlbumFeed(
  cred: WebCredential,
  request: GroupAlbumFeedRequest,
  signal?: AbortSignal,
): Promise<GroupAlbumFeedPage> {
  const raw = await webRequestJson<unknown>(groupAlbumFeedRequestUrl(cred, request), {
    method: 'GET',
    cookie: cookieHeader(cred),
    redirect: 'error',
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    maxResponseBytes: 8 * 1024 * 1024,
    signal,
  });
  return parseGroupAlbumFeed(raw, request);
}
