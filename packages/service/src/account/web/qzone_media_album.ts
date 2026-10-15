import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestText } from './http';
import { parseQzoneCallback } from './qzone';

interface FeedAlbum {
  uin?: unknown;
  skey?: unknown;
  albumid?: unknown;
  albumname?: unknown;
}
interface AlbumResponse {
  code?: number;
  data?: {
    feeds?: (FeedAlbum | null)[];
    album?: { id?: unknown; name?: unknown };
    name?: unknown;
    id?: unknown;
  };
}

function accepted(text: string): AlbumResponse {
  const data = parseQzoneCallback<AlbumResponse>(text);
  if (data.code === -3000 || data.code === -10000)
    throw new WebAuthError('相册信息登录态失效。', data.code);
  if (data.code !== 0) throw new Error('相册信息读取失败。');
  return data;
}

/** One recent photo-feed response, exact owner/post binding; never scan album names. */
export function parseQzonePostAlbum(text: string, hostUin: string, tid: string) {
  const data = accepted(text);
  if (!Array.isArray(data.data?.feeds)) throw new Error('照片动态响应缺少列表。');
  const matches = data.data.feeds.filter(
    (feed): feed is FeedAlbum & { albumid: string } =>
      !!feed &&
      String(feed.uin) === hostUin &&
      feed.skey === tid &&
      typeof feed.albumid === 'string' &&
      !!feed.albumid.trim() &&
      feed.albumid !== '0',
  );
  if (!matches.length) return null;
  const ids = new Set(matches.map((feed) => feed.albumid));
  if (ids.size !== 1) throw new Error('动态关联了多个相册，无法确认媒体归属。');
  return {
    hostUin,
    topicId: matches[0]!.albumid,
    name: typeof matches[0]!.albumname === 'string' ? matches[0]!.albumname.trim() : '',
  };
}

export function parseQzoneAlbumName(text: string, albumId: string): string {
  const data = accepted(text);
  const info = data.data?.album ?? data.data;
  if (
    !info ||
    typeof info !== 'object' ||
    (info.id !== undefined && String(info.id) !== albumId) ||
    typeof info.name !== 'string' ||
    !info.name.trim()
  )
    throw new Error('相册详情缺少名称或与请求不符。');
  return info.name.trim();
}

export async function fetchQzonePostAlbum(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  signal?: AbortSignal,
) {
  const get = (domain: string, path: string, params: Record<string, string>) =>
    webRequestText(
      `https://user.qzone.qq.com/proxy/domain/${domain}${path}?${new URLSearchParams({
        g_tk: String(computeBkn(cred.pskey || cred.skey)),
        ...params,
      })}`,
      {
        cookie: cookieHeader(cred),
        signal,
        retry: WEB_READ_RETRY,
        headers: { Referer: `https://user.qzone.qq.com/${hostUin}` },
      },
    );
  const album = parseQzonePostAlbum(
    await get('ic2.qzone.qq.com', '/cgi-bin/feeds/feeds2_html_picfeed_qqtab', {
      uin: cred.uin,
      hostUin,
      fuin: hostUin,
      appid: '4',
      begintime: '0',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
    }),
    hostUin,
    tid,
  );
  if (!album || album.name) return album;
  return {
    ...album,
    name: parseQzoneAlbumName(
      await get('photo.qzone.qq.com', '/cgi-bin/common/cgi_get_albuminfo_v2', {
        uin: hostUin,
        hostUin,
        albumId: album.topicId,
        appid: '4',
        source: 'qzone',
        plat: 'qzone',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        format: 'jsonp',
      }),
      album.topicId,
    ),
  };
}
