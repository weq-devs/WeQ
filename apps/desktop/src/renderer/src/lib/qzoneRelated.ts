import { projectQzoneFeed, qzoneLinkTarget } from './qzone';

export type RelatedKind = 'like' | 'comment' | 'forward' | 'mention' | 'push';
export interface RelatedComment {
  id: string;
  uin: string;
  content: string;
  images: string[];
  isReply?: boolean;
  parentCommentId?: string;
  replyId?: string;
}

export function relatedActionLine(activity: RelatedActivity): string {
  const label =
    activity.kind === 'like'
      ? '点赞了我'
      : activity.kind === 'comment'
        ? activity.comment?.isReply || /^回复/.test(activity.action)
          ? '回复了我'
          : '评论了我'
        : activity.kind === 'forward'
          ? '转发了我'
          : activity.kind === 'push'
            ? '推了我'
            : activity.kind === 'mention'
              ? activity.comment
                ? '在评论中@了我'
                : activity.action === '转发并@了我'
                  ? activity.action
                  : '在说说中@了我'
              : '互动类型未识别';
  const content =
    activity.comment && (activity.kind === 'comment' || activity.kind === 'mention')
      ? relatedPostExcerpt(
          { content: activity.comment.content, images: activity.comment.images, videos: [] },
          90,
        )
      : '';
  return content
    ? `${label}：${content}`
    : activity.kind === 'comment'
      ? `${label}：内容暂未取得`
      : label;
}
export interface RelatedActivity {
  kind: RelatedKind | 'unknown';
  kinds: RelatedKind[];
  action: string;
  actorUin: string | null;
  actorName: string;
  target: string | null;
  post: { hostUin: string; tid: string; nickname: string } | null;
  comment: RelatedComment | null;
  excerpt: string;
}
/** Resolve exact root/reply identities without matching names or similar text. */
export function relatedCommentTarget<
  T extends {
    id: string;
    uin: string;
    isReply: boolean;
    parentCommentId?: string;
    replyId?: string;
  },
>(notice: RelatedComment, comments: readonly T[]): T | null {
  const matches = comments.filter((comment) => {
    if (comment.uin !== notice.uin) return false;
    if (notice.isReply === true && !comment.isReply) return false;
    if (notice.isReply === false && comment.isReply) return false;
    if (!comment.isReply) return comment.id === notice.id;
    if (notice.parentCommentId && notice.parentCommentId !== comment.parentCommentId) return false;
    const legacy = comment.id.match(/^(.+)_r_(\d+)_([1-9]\d{4,19})$/);
    const prefix = comment.parentCommentId === undefined ? '' : `${comment.parentCommentId}_`;
    const suffix = `_${comment.uin}`;
    const oldId =
      prefix && comment.id.startsWith(prefix) && comment.id.endsWith(suffix)
        ? comment.id.slice(prefix.length, -suffix.length)
        : '';
    const replyId =
      comment.replyId ||
      (legacy && legacy[1] === comment.parentCommentId && legacy[3] === comment.uin
        ? legacy[2]
        : /^\d+$/.test(oldId)
          ? oldId
          : undefined);
    return comment.id === notice.id || replyId === (notice.replyId || notice.id);
  });
  return matches.length === 1 ? matches[0]! : null;
}

const rules: { kind: RelatedKind; pattern: RegExp }[] = [
  { kind: 'like', pattern: /(?:赞了|赞过|点赞了|给.{0,12}点了赞)/ },
  { kind: 'comment', pattern: /(?:评论了|回复了|留言了|^评论$|^回复$)/ },
  { kind: 'forward', pattern: /(?:转发了|^转发$)/ },
  { kind: 'mention', pattern: /(?:提到了|提到你|提到您|提到我|@了)/ },
  { kind: 'push', pattern: /(?:推荐了|推了|^推$|^推荐$)/ },
];
const text = (value: string): string => value.replace(/\s+/g, ' ').trim();
const validUin = (value: string | null | undefined): value is string =>
  !!value && /^[1-9]\d{4,19}$/.test(value);
function profileUin(anchor: Element): string | null {
  const explicit = anchor.getAttribute('data-uin');
  const linked = anchor
    .getAttribute('href')
    ?.match(/^(?:https?:)?\/\/user\.qzone\.qq\.com\/([1-9]\d{4,19})\/?(?:[?#].*)?$/i)?.[1];
  if (validUin(explicit) && validUin(linked) && explicit !== linked) return null;
  return validUin(explicit) ? explicit : validUin(linked) ? linked : null;
}
function detailTarget(doc: DocumentFragment): { hostUin: string; tid: string } | null {
  for (const node of doc.querySelectorAll('[data-detailurl]')) {
    const href = qzoneLinkTarget(node.getAttribute('data-detailurl') || '');
    if (!href) continue;
    const url = new URL(href);
    const match =
      url.hostname === 'user.qzone.qq.com' &&
      url.pathname.match(/^\/([1-9]\d{4,19})\/mood\/([a-zA-Z0-9_-]{1,128})(?:\.\d*)?\/?$/);
    if (match) return { hostUin: match[1]!, tid: match[2]! };
  }
  const metadata = doc.querySelector('[name="feed_data"]');
  const hostUin = metadata?.getAttribute('data-uin');
  const tid = metadata?.getAttribute('data-tid');
  return validUin(hostUin) && tid && /^[a-f0-9]{24}$/i.test(tid) ? { hostUin, tid } : null;
}

export function relatedPostExcerpt(
  post: {
    content: string;
    images: readonly string[];
    videos: readonly { videoId?: string; videoUrl?: string }[];
    repost?: {
      content: string;
      images: readonly string[];
      videos: readonly { videoId?: string; videoUrl?: string }[];
    };
  },
  limit = 120,
): string {
  const body = (item: { content: string; images: readonly string[]; videos: readonly unknown[] }) =>
    text(
      item.content.replace(
        /@\{uin:[^,}]+,nick:([^}]+)\}/g,
        (_match, nickname: string) => `@${nickname.replace(/,(?:who|type|uin):.*$/, '')}`,
      ),
    ) +
    '[图片]'.repeat(Math.min(item.images.length, limit)) +
    '[视频]'.repeat(Math.min(item.videos.length, limit));
  const original = post.repost;
  const own = original
    ? {
        ...post,
        images: post.images.filter((url) => !original.images.includes(url)),
        videos: post.videos.filter(
          (video) =>
            !original.videos.some(
              (other) =>
                (video.videoId && video.videoId === other.videoId) ||
                (video.videoUrl && video.videoUrl === other.videoUrl),
            ),
        ),
      }
    : post;
  const value = body(own) + (original ? `[转发：${body(original)}]` : '');
  const chars = [...value];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : value;
}

/** Only notification headers identify an action; bodies supply targets and excerpts. */
function projectRelatedUncached(
  feed: { html: string; actionHint?: string; nickname?: string },
  selfUin?: string,
): RelatedActivity {
  const template = document.createElement('template');
  template.innerHTML = feed.html;
  const doc = template.content;
  for (const element of doc.querySelectorAll('script,style,iframe,object,embed')) element.remove();
  const postTarget = detailTarget(doc);
  const header = doc.querySelector('.f-single-head .f-nick, .f-head .f-nick');
  const explicit = header?.querySelector('.state');
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...doc.querySelectorAll(
      '.feed-info, .f-single-head, .f-head, .f-nick, .qz_feed_plugin, .state, .f-aside',
    ),
  ]
    .filter(
      (node) =>
        !node.closest('.f-info,.qz_info_cut,.f-content,.f-single-content,.f-quote,.comments-item'),
    )
    .map((node) => {
      const copy = node.cloneNode(true) as Element;
      for (const body of copy.querySelectorAll(
        '.f-info,.qz_info_cut,.f-content,.f-single-content,.f-quote,.f-original,.comments-item,.comments-list,.user-list',
      ))
        body.remove();
      return copy;
    });
  let hint: HTMLSpanElement | null = null;
  if (feed.actionHint) {
    hint = document.createElement('span');
    hint.textContent = feed.actionHint;
    candidates.push(hint);
  }
  let kind: RelatedActivity['kind'] = 'unknown',
    action = '互动类型未识别',
    actorUin: string | null = null,
    actorName = '';
  const headerActor = header
    ? [...header.querySelectorAll('a')].find(
        (a) => profileUin(a) && !a.textContent?.trim().startsWith('@'),
      )
    : null;
  for (const candidate of candidates) {
    const raw = candidate.textContent ?? '';
    const masked = candidate.cloneNode(true) as Element;
    for (const anchor of masked.querySelectorAll('a'))
      if (profileUin(anchor)) anchor.textContent = ' '.repeat(anchor.textContent?.length ?? 0);
    let operation = masked.textContent ?? '';
    if (candidate === hint && feed.nickname && operation.startsWith(feed.nickname))
      operation = ' '.repeat(feed.nickname.length) + operation.slice(feed.nickname.length);
    const leading = operation.length - operation.trimStart().length;
    const matches = rules
      .flatMap((rule) => {
        const m = rule.pattern.exec(operation.trim());
        return m ? [{ kind: rule.kind, index: m.index + leading }] : [];
      })
      .sort((a, b) => a.index - b.index);
    const match = matches[0];
    if (!match) continue;
    kind = match.kind;
    action = text(raw).slice(0, 180);
    const actionIndex = match.index;
    const actor =
      headerActor ||
      [...candidate.querySelectorAll('a')].find(
        (a) =>
          profileUin(a) &&
          !!a.textContent &&
          raw.indexOf(a.textContent) + a.textContent.length <= actionIndex,
      );
    if (actor) {
      actorUin = profileUin(actor);
      actorName = text(actor.textContent || '');
    }
    break;
  }
  if (!actorUin && headerActor) {
    actorUin = profileUin(headerActor);
    actorName = text(headerActor.textContent || '');
  }
  const commentNodes = [...doc.querySelectorAll('.comments-item[data-tid]')].filter((node) => {
    const author = node.querySelector('.comments-content a.nickname');
    return (node.getAttribute('data-uin') || (author ? profileUin(author) : null)) === actorUin;
  });
  if (
    kind === 'unknown' &&
    !text(explicit?.textContent || '') &&
    actorUin &&
    commentNodes.length === 1 &&
    ['commentroot', 'replyroot'].includes(commentNodes[0]!.getAttribute('data-type') || '')
  ) {
    kind = 'comment';
    action = commentNodes[0]!.getAttribute('data-type') === 'replyroot' ? '回复' : '评论';
  }
  let comment: RelatedComment | null = null;
  if (actorUin && kind === 'comment') {
    const replies = commentNodes.filter((node) => node.getAttribute('data-type') === 'replyroot');
    const comments = /^回复/.test(action) && replies.length ? replies : commentNodes;
    if (comments.length === 1) {
      const node = comments[0]!,
        id = node.getAttribute('data-tid') || '';
      const copy = (node.querySelector('.comments-content') || node).cloneNode(true) as Element;
      const author = copy.querySelector('a.nickname');
      if (author && profileUin(author) === actorUin && !author.textContent?.trim().startsWith('@'))
        author.remove();
      for (const op of copy.querySelectorAll('.comments-op,.act-reply,.comments-item')) op.remove();
      const parent = node.parentElement?.closest('.comments-item[data-type="commentroot"]');
      const isReply =
        /^回复/.test(action) ||
        node.getAttribute('data-type') === 'replyroot' ||
        node.closest('.mod-comments-sub')
          ? true
          : node.getAttribute('data-type') === 'commentroot'
            ? false
            : undefined;
      const recipient = copy.querySelector('a.nickname');
      let removedRecipient = false;
      if (isReply && recipient) {
        const range = document.createRange();
        range.setStart(copy, 0);
        range.setEndBefore(recipient);
        if (/^[：:\s]*回复\s*$/.test(range.toString())) {
          range.setEndAfter(recipient);
          range.deleteContents();
          removedRecipient = true;
        }
      }
      const projected = projectQzoneFeed(
        `<div class="f-content"><div class="f-info">${copy.innerHTML}</div></div>`,
        false,
      );
      let content = projected.text.replace(/^[:：]\s*/, '');
      if (isReply) {
        const auto = content.match(/^@\{uin:([1-9]\d{4,19}),nick:[^}]*?,who:1\}\s*/);
        if (
          auto &&
          (auto[1] === parent?.getAttribute('data-uin') ||
            (auto[1] === selfUin && /^回复了(?:我|你|您)/.test(action)))
        ) {
          content = content.slice(auto[0].length);
          removedRecipient = true;
        }
      }
      const mentionsSelf =
        selfUin &&
        (isReply !== true || removedRecipient) &&
        ([...copy.querySelectorAll('a')].some(
          (a) => profileUin(a) === selfUin && a.textContent?.trim().startsWith('@'),
        ) ||
          [...content.matchAll(/@\{uin:([1-9]\d{4,19}),nick:[^}]*\}/g)].some(
            (match) => match[1] === selfUin,
          ));
      if (/^[a-zA-Z0-9_-]{1,128}$/.test(id))
        comment = {
          id,
          uin: actorUin,
          content,
          images: projected.images,
          isReply,
          ...(isReply
            ? { replyId: id, parentCommentId: parent?.getAttribute('data-tid') || undefined }
            : {}),
        };
      if (mentionsSelf) {
        kind = 'mention';
        action = '在评论中@了我';
      }
    }
  }
  const metadata = doc.querySelector('[name="feed_data"]');
  const originalTid = metadata?.getAttribute('data-origtid');
  if (
    kind === 'mention' &&
    !comment &&
    postTarget &&
    originalTid &&
    originalTid !== '0' &&
    originalTid !== postTarget.tid
  ) {
    action = '转发并@了我';
  }
  const targetTitle = doc.querySelector('.f-ct .txt-box-title');
  const targetAuthor = targetTitle
    ? [...targetTitle.querySelectorAll('a')].find(
        (a) => profileUin(a) === postTarget?.hostUin && !a.textContent?.trim().startsWith('@'),
      )
    : null;
  const snippet = targetTitle?.cloneNode(true) as Element | undefined;
  const snippetAuthor = snippet?.querySelector('a.nickname');
  if (snippetAuthor && !snippetAuthor.textContent?.trim().startsWith('@')) snippetAuthor.remove();
  for (const colon of snippet?.querySelectorAll('.state') ?? [])
    if (text(colon.textContent || '') === '：') colon.remove();
  if (kind === 'comment' && action === '评论')
    action = `评论了${postTarget?.hostUin === selfUin ? '我的' : '对方的'}说说`;
  if (kind === 'mention' && action === '提到我') action = '在说说中@了我';
  if (actorName && action.startsWith(actorName)) action = action.slice(actorName.length).trim();
  return {
    kind,
    kinds: kind === 'unknown' ? [] : [kind],
    action,
    actorUin,
    actorName,
    target: postTarget
      ? '说说'
      : (text(action).match(/说说|照片|相册|日志|分享|视频|评论|动态|留言板/)?.[0] ?? null),
    post: postTarget
      ? {
          ...postTarget,
          nickname:
            targetAuthor?.textContent?.trim() ||
            (postTarget.hostUin === actorUin ? actorName : postTarget.hostUin),
        }
      : null,
    comment,
    excerpt: text(snippet?.textContent || '').slice(0, 120),
  };
}

type RelatedFeed = { html: string; actionHint?: string; nickname?: string };
const projections = new WeakMap<
  RelatedFeed,
  { html: string; hint?: string; nickname?: string; values: Map<string, RelatedActivity> }
>();
export function projectQzoneRelated(feed: RelatedFeed, selfUin?: string): RelatedActivity {
  let cached = projections.get(feed);
  if (
    !cached ||
    cached.html !== feed.html ||
    cached.hint !== feed.actionHint ||
    cached.nickname !== feed.nickname
  ) {
    cached = { html: feed.html, hint: feed.actionHint, nickname: feed.nickname, values: new Map() };
    projections.set(feed, cached);
  }
  const scope = selfUin ?? '';
  let value = cached.values.get(scope);
  if (!value) {
    value = projectRelatedUncached(feed, selfUin);
    cached.values.set(scope, value);
  }
  return value;
}

const keys = new WeakMap<object, string>();
/** Metrics, signed URLs and relative-time labels must not change event identity. */
export function qzoneRelatedKey(feed: {
  uin: number;
  appid: number;
  key: string;
  time: number;
  html: string;
  actionHint?: string;
}): string {
  const cached = keys.get(feed);
  if (cached) return cached;
  const activity = projectQzoneRelated(feed);
  const key = JSON.stringify([
    feed.uin,
    feed.appid,
    feed.key,
    feed.time,
    activity.kind,
    activity.comment?.id ?? '',
  ]);
  keys.set(feed, key);
  return key;
}
