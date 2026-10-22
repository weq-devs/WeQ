export type GroupAlbumCardTarget =
  | { kind: 'album'; groupCode: string; albumId: string }
  | {
      kind: 'feed';
      groupCode: string;
      albumId: string;
      batchId: string;
      mediaId?: string;
      /** 旧详情链接的 f 定位串；保留但不猜成媒体或评论 ID。 */
      legacyFocus?: string;
    };

type Parsed = { state: 'unknown' | 'invalid' } | { state: 'target'; target: GroupAlbumCardTarget };
const unknown: Parsed = { state: 'unknown' },
  invalid: Parsed = { state: 'invalid' };
const group = (value: string) => /^[1-9]\d{4,19}$/.test(value);
const identifier = (value: string) => /^[A-Za-z0-9_.-]{1,256}$/.test(value);
const batch = (value: string) => /^[1-9]\d{0,19}$/.test(value);

function alias(params: URLSearchParams, keys: string[]): string {
  const values = keys.flatMap((key) => params.getAll(key));
  if (new Set(values).size > 1) throw new Error('目标字段不一致');
  return values[0] ?? '';
}
function target(
  groupCode: string,
  albumId: string,
  batchId?: string,
  mediaId?: string,
  legacyFocus?: string,
): Parsed {
  if (!group(groupCode) || !identifier(albumId)) return invalid;
  if (batchId === undefined)
    return { state: 'target', target: { kind: 'album', groupCode, albumId } };
  if (
    !batch(batchId) ||
    (mediaId && !identifier(mediaId)) ||
    (legacyFocus && !/^[\x21-\x7e]{1,512}$/.test(legacyFocus))
  )
    return invalid;
  return {
    state: 'target',
    target: {
      kind: 'feed',
      groupCode,
      albumId,
      batchId,
      ...(mediaId ? { mediaId } : {}),
      ...(legacyFocus ? { legacyFocus } : {}),
    },
  };
}

function parse(value: string, depth = 0): Parsed {
  if (!value || value.length > 8192 || depth > 2) return invalid;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port || url.hash) return invalid;
    const params = url.searchParams;
    if (url.protocol === 'mqzone:' && url.hostname === 'arouse') {
      if (!['/groupalbum/albumdetail', '/groupalbum/feeddetail'].includes(url.pathname))
        return unknown;
      if (
        ['f', 'picKey', 'photoid', 'photoId', 'commentid', 'commentId', 'replyid', 'replyId'].some(
          (key) => params.has(key),
        )
      )
        return invalid;
      const groupCode = alias(params, ['groupid', 'groupCode']),
        albumId = alias(params, ['albumid', 'albumId']);
      if (url.pathname.endsWith('/albumdetail')) {
        if (['batchid', 'batchId', 'llocid'].some((key) => params.has(key))) return invalid;
        return target(groupCode, albumId);
      }
      return target(
        groupCode,
        albumId,
        alias(params, ['batchid', 'batchId']),
        alias(params, ['llocid']),
      );
    }
    if (!['http:', 'https:'].includes(url.protocol)) return unknown;
    if (url.hostname === 'h5.qzone.qq.com') {
      const album = /^\/groupphoto\/inqq\/photo\/([^/]+)\/([^/]+)\/groupphoto\/?$/.exec(
        url.pathname,
      );
      if (album) {
        if (
          ['batchid', 'batchId', 'p', 'f', 'picKey', 'commentid', 'commentId'].some((key) =>
            params.has(key),
          )
        )
          return invalid;
        const groupCode = decodeURIComponent(album[1]!),
          albumId = decodeURIComponent(album[2]!);
        const groupKeys = ['groupCode', 'groupid', 'groupId'],
          albumKeys = ['albumId', 'albumid', 'aid'];
        if (
          (groupKeys.some((key) => params.has(key)) && alias(params, groupKeys) !== groupCode) ||
          (albumKeys.some((key) => params.has(key)) && alias(params, albumKeys) !== albumId)
        )
          return invalid;
        return target(groupCode, albumId);
      }
      const wrapped = /^\/groupphoto\/inqq\/detail\/([^/]+)\/groupphoto\/?$/.exec(url.pathname);
      if (wrapped) {
        const nested = parse(decodeURIComponent(wrapped[1]!), depth + 1);
        return nested.state === 'target' && nested.target.kind === 'feed' ? nested : invalid;
      }
      if (url.pathname === '/groupphoto/album') {
        if (
          ['f', 'picKey', 'commentid', 'commentId', 'replyid', 'replyId'].some((key) =>
            params.has(key),
          )
        )
          return invalid;
        if (params.has('inqq') && alias(params, ['inqq']) !== '1') return invalid;
        return target(
          alias(params, ['groupId']),
          alias(params, ['aid']),
          params.has('p') ? alias(params, ['p']) : undefined,
        );
      }
      return unknown;
    }
    if (url.hostname === 'mobile.qzone.qq.com' && url.pathname === '/photo/group/batch') {
      if (
        alias(params, ['a']) !== '422' ||
        alias(params, ['v']) !== '2' ||
        alias(params, ['cmd']) !== '2'
      )
        return invalid;
      return target(
        alias(params, ['u']),
        alias(params, ['i']),
        alias(params, ['p']),
        undefined,
        alias(params, ['f']),
      );
    }
    return unknown;
  } catch {
    return invalid;
  }
}

/** 只认观测到的群相册路由；不使用外层会话、标题或图片 URL 推断目标。 */
export function groupAlbumLinkTarget(value: string): GroupAlbumCardTarget | null {
  const parsed = parse(value);
  return parsed.state === 'target' ? parsed.target : null;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function jumps(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return record(value)
    ? ['jumpUrl', 'pcJumpUrl', 'harmonyJumpUrl'].flatMap((key) =>
        typeof value[key] === 'string' ? [value[key]] : [],
      )
    : [];
}
function combine(
  left: GroupAlbumCardTarget,
  right: GroupAlbumCardTarget,
): GroupAlbumCardTarget | null {
  if (left.groupCode !== right.groupCode || left.albumId !== right.albumId) return null;
  if (left.kind === 'album') return right;
  if (right.kind === 'album') return left;
  if (
    left.batchId !== right.batchId ||
    (left.mediaId && right.mediaId && left.mediaId !== right.mediaId) ||
    (left.legacyFocus && right.legacyFocus && left.legacyFocus !== right.legacyFocus)
  )
    return null;
  return {
    ...left,
    ...right,
    ...(left.mediaId || right.mediaId ? { mediaId: left.mediaId || right.mediaId } : {}),
    ...(left.legacyFocus || right.legacyFocus
      ? { legacyFocus: left.legacyFocus || right.legacyFocus }
      : {}),
  };
}

/** 仅从三类已观测 Ark 的明确跳转槽位取目标；多份目标冲突时不选其中之一。 */
export function groupAlbumArkTarget(app: string, meta: unknown): GroupAlbumCardTarget | null {
  if (!record(meta)) return null;
  const payload =
    app === 'com.tencent.activity.md'
      ? meta.activity
      : app === 'com.tencent.feed.lua'
        ? meta.feed
        : app === 'com.tencent.tuwen.lua'
          ? meta.news
          : null;
  if (!record(payload)) return null;
  const links =
    app === 'com.tencent.activity.md'
      ? [...jumps(payload.jumpUrl), ...jumps(payload.buttonJumpUrl)]
      : [...jumps(payload.jumpUrl), ...jumps(payload.pcJumpUrl), ...jumps(payload.legacyUrl)];
  let found: GroupAlbumCardTarget | null = null;
  for (const link of links) {
    const parsed = parse(link);
    if (parsed.state === 'invalid') return null;
    if (parsed.state !== 'target') continue;
    found = found ? combine(found, parsed.target) : parsed.target;
    if (!found) return null;
  }
  return found;
}
