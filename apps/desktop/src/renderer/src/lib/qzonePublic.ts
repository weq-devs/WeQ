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
 *   cell_adv         广告标记
 *
 * 这里只**读**字段，从不改写：互动接口要求把原始 feed 整体回传（见
 * `packages/service/src/account/web/qzone_public.ts`），所以每张卡片都保留
 * `feed` 原件，UI 只用投影出来的视图。
 *
 * 形状防御是本模块的重点：上游 cell 会随 qua 变化、也可能整块缺失，任何一处
 * 都必须退化成「不显示」而不是抛错，否则一条畸形动态会毁掉整页。
 */

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

/** 富文本项里的 `[em]eXXX[/em]` 原样保留，交给渲染层的 qzoneTextParts 解析。 */
function richText(items: unknown): string {
  return asArray(items)
    .map((item) => {
      const value = asObject(item);
      if (!value) return '';
      // type 0 是文本；其它类型可能是图片 / @ / 链接，正文里没有可读文字。
      return asNumber(value.type) === 0 ? asString(value.content) : '';
    })
    .join('')
    .trim();
}

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
      const key = `${prefix}:v:${asString(video.id) || index}`;
      if (!src && !poster) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      media.push({
        key,
        kind: 'video',
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
  const upvote = asObject(raw.cell_upvote);

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
    upvoted: Boolean(upvote && asBool(upvote.liked)),
    // `feed_type === 3` 是广告；旧空间导出链也把广告单独标出来。
    advertisement: asNumber(common.feed_type) === 3,
    actionable: Boolean(union && Object.keys(union).length > 0),
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
