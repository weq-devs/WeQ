import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestText } from './http';
import { mapMsgList, parseQzoneCallback } from './qzone';

function hasMore(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function accepted(text: string, hostUin: string, tid: string): Record<string, unknown> {
  const data = parseQzoneCallback<Record<string, unknown>>(text);
  if (data.code !== 0) {
    if (data.code === -3000 || data.code === -10000)
      throw new WebAuthError('说说补全登录态失效。', data.code);
    throw new Error('暂时无法补全这条说说。');
  }
  if (
    (data.tid !== undefined && String(data.tid) !== tid) ||
    (data.uin !== undefined && String(data.uin) !== hostUin)
  )
    throw new Error('补全结果与当前说说不匹配。');
  return data;
}

async function read(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  cgi: string,
  extra: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const query = new URLSearchParams({
    uin: hostUin,
    tid,
    t1_source: '1',
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
    format: 'jsonp',
    ...extra,
  });
  return webRequestText(
    `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/${cgi}?${query}`,
    {
      cookie: cookieHeader(cred),
      signal,
      retry: WEB_READ_RETRY,
      headers: { Referer: `https://user.qzone.qq.com/${hostUin}` },
    },
  );
}

export function parseQzonePostDetail(text: string, hostUin: string, tid: string) {
  const data = accepted(text, hostUin, tid);
  if (typeof data.content !== 'string') throw new Error('说说详情缺少正文。');
  const post = mapMsgList({ msglist: [{ ...data, tid, content: data.content }] }).list[0]!;
  const { nativeMedia: _nativeMedia, ...visiblePost } = post;
  return {
    post: visiblePost,
    content: post.content,
    contentHasMore: hasMore(data.has_more_con),
    contentComplete:
      data.has_more_con === 0 || data.has_more_con === '0' || data.has_more_con === false,
    repost: post.repost ?? null,
    repostHasMore: hasMore(data.rt_has_more_con),
    repostComplete:
      data.rt_has_more_con === 0 || data.rt_has_more_con === '0' || data.rt_has_more_con === false,
  };
}

export async function fetchQzonePostDetail(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  signal?: AbortSignal,
) {
  return parseQzonePostDetail(
    await read(
      cred,
      hostUin,
      tid,
      'emotion_cgi_msgdetail_v6',
      {
        hostuin: cred.uin,
        not_trunc_con: '1',
        code_version: '1',
      },
      signal,
    ),
    hostUin,
    tid,
  );
}

export function parseQzonePostImages(text: string, hostUin: string, tid: string): string[] {
  const data = accepted(text, hostUin, tid);
  if (
    !Array.isArray(data.imageUrls) ||
    data.imageUrls.some((url) => typeof url !== 'string' || !url)
  )
    throw new Error('说说附图响应格式无效。');
  return [...new Set(data.imageUrls as string[])];
}

export async function fetchQzonePostImages(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  signal?: AbortSignal,
) {
  return parseQzonePostImages(
    await read(cred, hostUin, tid, 'emotion_cgi_get_pics_v6', {}, signal),
    hostUin,
    tid,
  );
}
