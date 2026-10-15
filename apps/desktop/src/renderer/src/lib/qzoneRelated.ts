export type RelatedKind = 'like' | 'comment' | 'forward' | 'mention';

export interface RelatedActivity {
  kind: RelatedKind | 'unknown';
  action: string;
  actorUin: string | null;
  actorName: string;
  target: string | null;
}

const rules: { kind: RelatedKind; pattern: RegExp }[] = [
  { kind: 'like', pattern: /(?:赞了|赞过|点赞了|给.{0,12}点了赞)/ },
  { kind: 'comment', pattern: /(?:评论了|回复了|留言了)/ },
  { kind: 'forward', pattern: /转发了/ },
  { kind: 'mention', pattern: /(?:提到了|提到你|提到您|@了)/ },
];
const text = (value: string): string => value.replace(/\s+/g, ' ').trim();
function profileUin(anchor: Element): string | null {
  const value =
    anchor.getAttribute('data-uin') ||
    anchor
      .getAttribute('href')
      ?.match(/^(?:https?:)?\/\/user\.qzone\.qq\.com\/([1-9]\d{4,19})\/?(?:[?#].*)?$/)?.[1];
  return value && /^[1-9]\d{4,19}$/.test(value) ? value : null;
}

/** Classify notification metadata only. Post/quoted/comment bodies cannot claim an action. */
export function projectQzoneRelated(feed: {
  html: string;
  actionHint?: string;
  nickname?: string;
}): RelatedActivity {
  // Template contents stay disconnected: no scripts, images or frames become live resources.
  const template = document.createElement('template');
  template.innerHTML = feed.html;
  const doc = template.content;
  for (const element of doc.querySelectorAll('script,style,iframe,object,embed')) element.remove();
  const candidates = [
    ...doc.querySelectorAll(
      '.feed-info, .f-single-head, .f-head, .f-nick, .qz_feed_plugin, .state, .f-aside',
    ),
  ]
    .filter(
      (node) =>
        !node.closest(
          '.f-info, .qz_info_cut, .f-content, .f-single-content, .f-quote, .comments-item',
        ),
    )
    .map((node) => {
      const copy = node.cloneNode(true) as Element;
      for (const body of copy.querySelectorAll(
        '.f-info,.qz_info_cut,.f-content,.f-single-content,.f-quote,.f-original,.comments-item,.comments-list,.user-list',
      ))
        body.remove();
      return copy;
    });
  const hint = feed.actionHint ? document.createElement('span') : null;
  if (hint) {
    hint.textContent = feed.actionHint ?? '';
    candidates.push(hint);
  }
  for (const candidate of candidates) {
    const rawLabel = candidate.textContent ?? '';
    const masked = candidate.cloneNode(true) as Element;
    for (const anchor of masked.querySelectorAll('a')) {
      if (profileUin(anchor)) anchor.textContent = ' '.repeat(anchor.textContent?.length ?? 0);
    }
    let operation = masked.textContent ?? '';
    if (candidate === hint && feed.nickname && rawLabel.startsWith(feed.nickname))
      operation = ' '.repeat(feed.nickname.length) + operation.slice(feed.nickname.length);
    const matches = rules
      .flatMap((rule) => {
        const match = rule.pattern.exec(operation);
        return match
          ? [{ kind: rule.kind, index: match.index, end: match.index + match[0].length }]
          : [];
      })
      .sort((a, b) => a.index - b.index);
    const action = matches[0];
    if (!action) continue;
    // Only metadata preceding the action can identify its actor, not a linked target.
    const actor = [...candidate.querySelectorAll('a')].find((anchor) => {
      const name = anchor.textContent ?? '';
      return (
        profileUin(anchor) &&
        name &&
        rawLabel.indexOf(name) >= 0 &&
        rawLabel.indexOf(name) + name.length <= action.index
      );
    });
    const target =
      rawLabel.slice(action.end).match(/说说|照片|相册|日志|分享|视频|评论|动态|留言板/)?.[0] ??
      rawLabel
        .slice(0, action.index)
        .match(/在(说说|照片|相册|日志|分享|视频|评论|动态|留言板)(?:中|里|内)/)?.[1] ??
      null;
    return {
      kind: action.kind,
      action: text(rawLabel).slice(0, 180),
      actorUin: actor ? profileUin(actor) : null,
      actorName: actor ? text(actor.textContent ?? '') : '',
      target,
    };
  }
  return { kind: 'unknown', action: '互动类型未识别', actorUin: null, actorName: '', target: null };
}

/** Related rows can share a post key but represent different interactions. */
export function qzoneRelatedKey(feed: {
  uin: number;
  appid: number;
  key: string;
  time: number;
  html: string;
  actionHint?: string;
}): string {
  return JSON.stringify([
    feed.uin,
    feed.appid,
    feed.key,
    feed.time,
    feed.actionHint ?? '',
    feed.html,
  ]);
}
