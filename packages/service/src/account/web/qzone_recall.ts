import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestText } from './http';
import { mapFeeds, parseQzoneCallback, type RawFeedItem } from './qzone';

type Group = 'data' | 'host_data' | 'friend_data' | 'about_data' | 'firstpage_data';
interface RawRecallResponse {
  code?: number;
  data?: Partial<Record<Group, (RawFeedItem | null)[] | null>> & {
    main?: {
      hasMoreFeeds?: unknown;
      hasMoreFeeds_0?: unknown;
      hasMoreFeeds_1?: unknown;
      offset?: unknown;
    };
  };
}

const more = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'true';

export function parseQzoneRecall(text: string, kind: 'related' | 'memories', offset = 0) {
  const response = parseQzoneCallback<RawRecallResponse>(text);
  if (response.code !== 0) {
    if (response.code === -3000 || response.code === -10000)
      throw new WebAuthError('空间回顾登录态失效。', response.code);
    throw new Error('暂时无法读取空间回顾。');
  }
  const data = response.data;
  if (!data || typeof data !== 'object') throw new Error('空间回顾响应格式无效。');
  const groups: Group[] =
    kind === 'related'
      ? ['data']
      : ['data', 'host_data', 'friend_data', 'about_data', 'firstpage_data'];
  if (!groups.some((name) => Array.isArray(data[name]))) throw new Error('空间回顾缺少内容列表。');
  const rows = groups
    .flatMap((name) => (Array.isArray(data[name]) ? data[name] : []))
    .filter((row): row is RawFeedItem => Boolean(row) && typeof row === 'object');
  const feeds = mapFeeds({ data: { data: rows } }).feeds;
  const main = data.main ?? {};
  const hasMore =
    kind === 'related'
      ? more(main.hasMoreFeeds)
      : more(main.hasMoreFeeds_0) || more(main.hasMoreFeeds_1);
  const rawOffset = main.offset;
  const nextOffset =
    typeof rawOffset === 'number' || (typeof rawOffset === 'string' && /^\d+$/.test(rawOffset))
      ? Number(rawOffset)
      : null;
  const validOffset =
    kind === 'related' &&
    hasMore &&
    nextOffset !== null &&
    Number.isSafeInteger(nextOffset) &&
    nextOffset > offset &&
    nextOffset <= 100000;
  return {
    feeds,
    hasMore,
    nextCursor: validOffset ? `offset=${nextOffset}` : undefined,
    incomplete: hasMore && !validOffset,
  };
}

async function request(
  cred: WebCredential,
  cgi: string,
  params: Record<string, string>,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    ...params,
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
  });
  return webRequestText(
    `https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/${cgi}?${query}`,
    {
      cookie: cookieHeader(cred),
      signal,
      retry: WEB_READ_RETRY,
      headers: { Referer: `https://user.qzone.qq.com/${cred.uin}` },
    },
  );
}

export async function fetchQzoneRelated(cred: WebCredential, offset = 0, signal?: AbortSignal) {
  return parseQzoneRecall(
    await request(
      cred,
      'feeds2_html_pav_all',
      {
        uin: cred.uin,
        begin_time: '0',
        end_time: '0',
        getappnotification: '1',
        getnotifi: '1',
        has_get_key: '0',
        offset: String(offset),
        set: '0',
        count: '10',
        useutf8: '1',
        outputhtmlfeed: '1',
        scope: '1',
      },
      signal,
    ),
    'related',
    offset,
  );
}

export async function fetchQzoneMemories(cred: WebCredential, year: number, signal?: AbortSignal) {
  return parseQzoneRecall(
    await request(
      cred,
      'feeds2_html_today_lastyear',
      {
        login_uin: cred.uin,
        year: String(year),
        mode: '1',
        refer: 'qzone',
        useutf8: '1',
        count: '30',
      },
      signal,
    ),
    'memories',
  );
}
