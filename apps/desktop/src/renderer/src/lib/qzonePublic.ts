/**
 * 空友爱看（公共空间）feed 投影 —— 把上游 `cell_*` 结构转成 UI 需要的形状。
 *
 * 上游推荐流**不是**旧空间那套 HTML 片段，而是一棵 `cell_*` 结构树：
 *
 *   cell_common      身份（union_id / feed_id / feed_type / domain_type / cur_like_key）
 *   cell_user_info   作者（uid / uin / nick / portrait / can_follow / isfollowed）
 *   cell_summary     正文（`summary[]`，type 0 = 文本，type 3 = 内嵌媒体）
 *   cell_media       媒体（`media_items[]`，每项 image 或 video）
 *   cell_like        赞数 / 自己是否赞过
 *   cell_comment     评论数 + 首屏评论
 *   cell_foward_info 转发数
 *   cell_visitor     浏览数
 *   cell_upvote      推人数 / 本人是否已推 / 用户预览
 *   cell_adv         广告标记
 *
 * 这里只**读**字段，从不改写：互动接口要求把原始 feed 整体回传（见
 * `packages/service/src/account/web/qzone_public.ts`），所以每张卡片都保留
 * `feed` 原件，UI 只用投影出来的视图。
 *
 * 形状防御是本模块的重点：上游 cell 会随 qua 变化、也可能整块缺失，任何一处
 * 都必须退化成「不显示」而不是抛错，否则一条畸形动态会毁掉整页。
 */

import type { QzoneUpvotePreview } from '@weqbot/protocol';
import { qzoneLinkTarget } from './qzone';
import type { QzoneEmotion } from '../views/qzone_types';

export type PublicJson = Record<string, unknown>;

export function asObject(value: unknown): PublicJson | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as PublicJson)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // 上游大量数字以字符串下发（`time` / `reply_num` / `video_time`）。
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1;
}

/** 只放行 qq.com / qpic.cn / gtimg 系域名，别的一律当不可用。 */
export function publicMediaSource(value: unknown): string | null {
  const text = asString(value).trim();
  if (!text) return null;
  try {
    const url = new URL(text.startsWith('//') ? `https:${text}` : text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const allowed = [
      'qpic.cn',
      'qlogo.cn',
      'gtimg.cn',
      'gtimg.com',
      'photo.qq.com',
      'qq.com',
      'myqcloud.com',
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
    return allowed ? url.href : null;
  } catch {
    return null;
  }
}

export interface PublicMedia {
  key: string;
  kind: 'image' | 'video';
  videoId?: string;
  src: string;
  poster: string;
  width: number;
  height: number;
  durationMs: number;
}

export interface PublicAuthor {
  uid: string;
  uin: string;
  nick: string;
  portrait: string;
  /** 上游是否允许关注这位作者。 */
  canFollow: boolean;
  followed: boolean;
}

export interface PublicFeedView {
  /** 列表内稳定 key：优先 union_id.uf_key，其次 feed_id，最后用序号兜底。 */
  key: string;
  /** 原始 feed —— 详情与所有互动都把它整体回传，绝不用 tid 拼造。 */
  feed: PublicJson;
  author: PublicAuthor;
  time: number;
  text: string;
  media: PublicMedia[];
  likeCount: number | null;
  commentCount: number | null;
  forwardCount: number | null;
  viewCount: number | null;
  liked: boolean;
  /** 「推」过没有（`cell_upvote` 存在且标记为已推）。 */
  upvoted: boolean;
  upvote: QzoneUpvotePreview | null;
  advertisement: boolean;
  /** 缺少 union_id 的动态无法互动，只能展示。 */
  actionable: boolean;
}

export interface PublicCommentView {
  raw: PublicJson;
  id: string;
  author: PublicAuthor;
  text: string;
  media: PublicMedia[];
  time: number;
  likeCount: number;
  liked: boolean;
  replyCount: number;
  replies: PublicCommentView[];
  /** 首屏回复之外还有的续页标记；空串表示没有更多。 */
  replyCursor: string;
}

function authorOf(source: unknown): PublicAuthor {
  const user = asObject(asObject(source)?.user) ?? {};
  return {
    uid: asString(user.uid).trim(),
    uin: asString(user.uin).trim(),
    nick: asString(user.nick).trim(),
    portrait: asString(user.portrait).trim(),
    canFollow: asBool(user.can_follow),
    followed: asBool(user.isfollowed),
  };
}

import { publicRichText as richText } from '@weq/service/qzone-public-text';

function pickImageUrl(image: PublicJson): string {
  const direct = publicMediaSource(asObject(image.default_url)?.url);
  if (direct) return direct;
  // 没有 default_url 时取 photo_url 里尺寸最大的一档。
  let best = '';
  let bestWidth = -1;
  for (const entry of asArray(image.photo_url)) {
    const url = asObject(asObject(entry)?.url);
    if (!url) continue;
    const source = publicMediaSource(url.url);
    if (!source) continue;
    const width = asNumber(url.width) ?? 0;
    if (width > bestWidth) {
      bestWidth = width;
      best = source;
    }
  }
  return best;
}

function mediaFromItems(items: unknown, prefix: string): PublicMedia[] {
  const media: PublicMedia[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of asArray(items).entries()) {
    const item = asObject(entry);
    if (!item) continue;
    const video = asObject(item.video);
    if (video) {
      // `url` 是首选直链；`video_url[]` 是分档列表（spec 5/6 等），取第一档可用的。
      const src =
        publicMediaSource(video.url) ||
        asArray(video.video_url)
          .map((candidate) => publicMediaSource(asObject(asObject(candidate)?.url)?.url))
          .find((value): value is string => Boolean(value)) ||
        '';
      const cover = asObject(video.cover);
      const poster = cover ? pickImageUrl(cover) : '';
      const videoId = asString(video.id);
      const key = `${prefix}:v:${videoId || index}`;
      if (!src && !poster) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      media.push({
        key,
        kind: 'video',
        videoId,
        src,
        poster,
        width: asNumber(video.width) ?? 0,
        height: asNumber(video.height) ?? 0,
        durationMs: asNumber(video.video_time) ?? 0,
      });
      continue;
    }
    const image = asObject(item.image);
    if (!image) continue;
    const src = pickImageUrl(image);
    if (!src) continue;
    const key = `${prefix}:i:${src}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const size = asObject(image.default_url);
    media.push({
      key,
      kind: 'image',
      src,
      poster: '',
      width: asNumber(size?.width) ?? 0,
      height: asNumber(size?.height) ?? 0,
      durationMs: 0,
    });
  }
  return media;
}

/**
 * 一条推荐动态的视图。`index` 只在缺少任何身份字段时用于生成稳定 key。
 */
export function projectPublicFeed(feed: unknown, index = 0): PublicFeedView | null {
  const raw = asObject(feed);
  if (!raw) return null;
  const common = asObject(raw.cell_common) ?? {};
  const union = asObject(common.union_id);
  const key =
    asString(union?.uf_key) || asString(common.feed_id) || asString(union?.feed_id) || `#${index}`;

  const summary = asObject(raw.cell_summary);
  const summaryItems = asArray(summary?.summary);
  // 正文里内嵌的媒体（type 3）和 cell_media 是两处来源，都收。
  const inlineMedia = summaryItems.flatMap((item) => {
    const value = asObject(item);
    return value && asNumber(value.type) !== 0 ? asArray(value.media_items) : [];
  });
  const media = [
    ...mediaFromItems(asArray(asObject(raw.cell_media)?.media_items), key),
    ...mediaFromItems(inlineMedia, `${key}:inline`),
  ];

  const like = asObject(raw.cell_like) ?? {};
  const comment = asObject(raw.cell_comment) ?? {};
  const forward = asObject(raw.cell_foward_info) ?? {};
  const visitor = asObject(raw.cell_visitor) ?? {};
  const upvote = projectPublicUpvote(raw.cell_upvote);

  return {
    key,
    feed: raw,
    author: authorOf(raw.cell_user_info),
    time: asNumber(common.time) ?? 0,
    text: richText(summaryItems),
    media,
    likeCount: asNumber(like.num),
    commentCount: asNumber(comment.num),
    forwardCount: asNumber(forward.retweet_count),
    viewCount: asNumber(visitor.view_num),
    liked: asBool(like.liked),
    upvoted: upvote?.upvoted === true,
    upvote,
    // `feed_type === 3` 是广告；旧空间导出链也把广告单独标出来。
    advertisement: asNumber(common.feed_type) === 3,
    actionable: Boolean(union && Object.keys(union).length > 0),
  };
}

/** 腾讯 pc-qzone 的 num / upvoted / upvote_mans，与普通赞的 liked 不同。 */
export function projectPublicUpvote(value: unknown): QzoneUpvotePreview | null {
  const cell = asObject(value);
  if (!cell) return null;
  const count = asNumber(cell.num);
  return {
    count: count !== null && Number.isSafeInteger(count) && count >= 0 ? count : null,
    upvoted:
      cell.upvoted === true || cell.upvoted === 1
        ? true
        : cell.upvoted === false || cell.upvoted === 0
          ? false
          : null,
    users: asArray(cell.upvote_mans)
      .slice(0, 256)
      .flatMap((entry) => {
        const source = asObject(asObject(entry)?.user);
        if (!source) return [];
        const uin = asString(source.uin);
        const uid = asString(source.uid);
        const nickname = asString(source.nick);
        if (!uin && !uid && !nickname) return [];
        return [
          {
            uin: /^[1-9]\d{4,19}$/.test(uin) ? uin : '',
            uid,
            nickname,
            portrait: publicMediaSource(source.portrait) ?? undefined,
          },
        ];
      }),
  };
}

function commentMedia(content: unknown): PublicMedia[] {
  return asArray(content).flatMap((item) =>
    mediaFromItems(asArray(asObject(item)?.media_items), 'c'),
  );
}

/** 一条评论或回复的视图；`replies` 只来自详情 / 回复页带回的首屏。 */
export function projectPublicComment(comment: unknown, prefix = 'c'): PublicCommentView | null {
  const raw = asObject(comment);
  if (!raw) return null;
  const like = asObject(raw.like) ?? {};
  const id = asString(raw.id);
  return {
    raw,
    id,
    author: authorOf(raw),
    text: richText(raw.content),
    media: commentMedia(raw.content),
    time: asNumber(raw.time) ?? 0,
    likeCount: asNumber(like.count) ?? 0,
    liked: asBool(like.status),
    replyCount: asNumber(raw.reply_num) ?? 0,
    replies: asArray(raw.replys)
      .map((reply, index) => projectPublicComment(reply, `${prefix}:${id}:r${index}`))
      .filter((reply): reply is PublicCommentView => Boolean(reply)),
    replyCursor: asString(raw.reply_attach_info),
  };
}

/**
 * 详情响应的首批评论与续页标记。
 * 详情形状是 `{ feed: { feed: <裸 feed> }, attach_info, has_more }`，
 * 首批评论在 `feed.feed.cell_comment.comments`。
 */
export function projectPublicDetail(data: unknown): {
  comments: PublicCommentView[];
  cursor: string;
  hasMore: boolean;
} {
  const root = asObject(data) ?? {};
  const feed = asObject(asObject(root.feed)?.feed) ?? {};
  const comment = asObject(feed.cell_comment) ?? {};
  return {
    comments: asArray(comment.comments)
      .map((entry, index) => projectPublicComment(entry, `d${index}`))
      .filter((entry): entry is PublicCommentView => Boolean(entry)),
    cursor: asString(root.attach_info),
    hasMore: asBool(root.has_more),
  };
}

/** 评论续页：`{ cell_comment: { comments }, attach_info, has_more }`。 */
export function projectPublicCommentsPage(data: unknown): {
  comments: PublicCommentView[];
  cursor: string;
  hasMore: boolean;
} {
  const root = asObject(data) ?? {};
  const comment = asObject(root.cell_comment) ?? {};
  return {
    comments: asArray(comment.comments)
      .map((entry, index) => projectPublicComment(entry, `p${index}`))
      .filter((entry): entry is PublicCommentView => Boolean(entry)),
    cursor: asString(root.attach_info),
    hasMore: asBool(root.has_more),
  };
}

/** 回复续页：`{ replys, reply_attach_info, has_more, total }`。 */
export function projectPublicRepliesPage(
  data: unknown,
  prefix: string,
): {
  replies: PublicCommentView[];
  cursor: string;
  hasMore: boolean;
  total: number | null;
} {
  const root = asObject(data) ?? {};
  return {
    replies: asArray(root.replys)
      .map((entry, index) => projectPublicComment(entry, `${prefix}:r${index}`))
      .filter((entry): entry is PublicCommentView => Boolean(entry)),
    cursor: asString(root.reply_attach_info),
    hasMore: asBool(root.has_more),
    total: asNumber(root.total),
  };
}

/** 合并分页结果时按评论 id 去重，保留先到的版本。 */
export function mergePublicComments(
  current: PublicCommentView[],
  next: PublicCommentView[],
): PublicCommentView[] {
  const seen = new Set(current.map((entry) => entry.id).filter(Boolean));
  const merged = [...current];
  for (const entry of next) {
    if (entry.id && seen.has(entry.id)) continue;
    if (entry.id) seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

/** 上游 `entrances` 里的两个开关；其余字段一律不参与 UI 判定。 */
export function publicCapabilities(entrances: unknown): {
  available: boolean;
  canUpvote: boolean;
  canFollow: boolean;
  canComment: boolean;
} {
  const flags = asObject(entrances) ?? {};
  return {
    available: asBool(flags.public_qzone_entrance_switch),
    canUpvote: asBool(flags.can_upvote),
    // 上游没有单独的「能否评论」开关；评论入口跟着爱看入口走。
    canFollow: asBool(flags.can_public_follow),
    canComment: asBool(flags.public_qzone_entrance_switch),
  };
}

export function publicGridMedia(media: PublicMedia[]): {
  images: string[];
  videos: {
    coverUrl: string;
    videoUrl: string;
    videoId: string;
    duration: number;
    mediaIndex: number;
  }[];
} {
  return {
    images: media.filter((item) => item.kind === 'image').map((item) => item.src),
    videos: media.flatMap((item, mediaIndex) =>
      item.kind === 'video'
        ? [
            {
              coverUrl: item.poster,
              videoUrl: item.src,
              videoId: item.videoId ?? '',
              duration: item.durationMs,
              mediaIndex,
            },
          ]
        : [],
    ),
  };
}

const homeFeedTypes: Partial<Record<number, string>> = {
  2: '日志',
  4: '相册',
  202: '分享',
  311: '说说',
};

export function isOrdinaryQzonePost(uin: string, tid: string): boolean {
  return (
    /^[1-9]\d{4,19}$/.test(uin) &&
    /^[\da-f]{24}$/i.test(tid) &&
    String(Number.parseInt(tid.slice(0, 8).match(/../g)!.reverse().join(''), 16)) === uin
  );
}

/** Without the original share resource CreateShare cannot target this feed. */
export function canShareQzoneFeed(feed: PublicJson): boolean {
  const mask = asObject(feed.cell_common)?.operate_mask;
  const share = asObject(asObject(feed.cell_operation)?.share_outside);
  const resource = asObject(share?.share_access_resource);
  return Boolean(
    (mask === undefined ||
      (typeof mask === 'number' &&
        Number.isSafeInteger(mask) &&
        mask >= 0 &&
        !(mask & (1 << 17)))) &&
      asString(resource?.busi_id) &&
      asString(resource?.resource_id) &&
      asString(feed.cell_feed_transfer),
  );
}

/** 个人主页与推荐流共用 cell 结构。只有可核对作者的说说能走普通详情。 */
export function projectQzoneHomeFeed(view: PublicFeedView) {
  const common = asObject(view.feed.cell_common);
  const appId = asNumber(common?.app_id);
  const type =
    (appId === null ? undefined : homeFeedTypes[appId]) ??
    (view.media.some((item) => item.kind === 'video') ? '视频' : '动态');
  const title = asString(common?.title).trim();
  const tid = asString(asObject(common?.union_id)?.feed_id);
  const detailId =
    (appId === null || appId === 311) && isOrdinaryQzonePost(view.author.uin, tid)
      ? tid.toLowerCase()
      : null;
  const href = detailId
    ? null
    : qzoneLinkTarget(asString(asObject(view.feed.cell_operation)?.qq_url));
  return { type, title, detailId, href };
}

/** 日志 cell_id 对应日志列表的 blogId，动态时间和 union_id.feed_id 都不是日志编号。 */
export function qzoneHomeBlogId(view: PublicFeedView): string | null {
  const common = asObject(view.feed.cell_common);
  if (asNumber(common?.app_id) !== 2 || !/^[1-9]\d{4,19}$/.test(view.author.uin)) return null;
  const id = String(common?.cell_id ?? '');
  return /^[1-9]\d{0,15}$/.test(id) ? id : null;
}

/** 分享列表与评论 CGI 使用外层分享的 cell_id，不是被分享内容或动态的 feed_id。 */
export function qzoneHomeShareId(view: PublicFeedView): string | null {
  const common = asObject(view.feed.cell_common);
  if (asNumber(common?.app_id) !== 202 || !/^[1-9]\d{4,19}$/.test(view.author.uin)) return null;
  const id = common?.cell_id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  return typeof id === 'string' && /^[1-9]\d{0,31}$/.test(id) ? id : null;
}

export function qzoneHomePostPreview(view: PublicFeedView, tid: string): QzoneEmotion {
  return {
    tid,
    time: view.time,
    content: view.text,
    commentNum: view.commentCount,
    forwardNum: view.forwardCount ?? undefined,
    isPrivate: false,
    ...publicGridMedia(view.media),
  };
}

export function mergeQzoneHomePost(preview: QzoneEmotion, detail: QzoneEmotion): QzoneEmotion {
  if (preview.tid !== detail.tid) throw new Error('补全结果与当前说说不匹配。');
  // For a repost, the flat home media can belong to the quoted post.
  const keepPreviewMedia = !detail.repost && !detail.images.length && !detail.videos.length;
  return {
    ...detail,
    time: detail.time || preview.time,
    commentNum: detail.commentNum ?? preview.commentNum,
    forwardNum: detail.forwardNum ?? preview.forwardNum,
    images: keepPreviewMedia ? preview.images : detail.images,
    videos: keepPreviewMedia ? preview.videos : detail.videos,
  };
}
