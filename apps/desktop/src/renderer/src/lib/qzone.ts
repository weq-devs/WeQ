/** Native projection of feed HTML. Remote attributes, scripts and controls never render. */
export function qzoneMediaSource(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
      return null;
    if (
      !['qq.com', 'qpic.cn', 'gtimg.cn', 'gtimg.com'].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Remote links remain data; only explicit web destinations are opened. */
export function qzoneLinkTarget(value: string): string | null {
  if (!/^(?:https?:)?\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value, 'https://user.qzone.qq.com/');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
      return null;
    if (
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') ||
      url.hostname.endsWith('.local') ||
      !url.hostname.includes('.') ||
      /^[\d.]+$/.test(url.hostname) ||
      url.hostname.includes(':')
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Feed identity/permalink anchors navigate within Qzone; they are not shared cards. */
function isQzoneFeedNavigation(anchor: Element, href: string): boolean {
  if (anchor.matches('.nickname, .q_namecard, [profileuin]')) return true;
  const url = new URL(href);
  return (
    url.hostname === 'user.qzone.qq.com' &&
    /^\/[1-9]\d{4,19}(?:\/mood(?:\/[^/]+)?)?\/?$/.test(url.pathname)
  );
}

export function projectQzoneFeed(
  html: string,
  allowRepost = true,
): {
  text: string;
  images: string[];
  links: { href: string; text: string; cover?: string }[];
  tid: string | null;
  likeCount: number | null;
  commentCount: number | null;
  counterKey: string | null;
  forwardCount: number | null;
  advertisement: boolean;
  unsupported: boolean;
  repost: {
    tid: string;
    uin: string;
    nickname: string;
    content: string;
    images: string[];
    videos: [];
  } | null;
} {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const unsupported = /功能内测中|内容暂不支持查看/.test(doc.body.textContent ?? '');
  for (const image of doc.querySelectorAll('img')) {
    const source =
      image.getAttribute('src') ||
      image.getAttribute('data-src') ||
      image.getAttribute('lz-src') ||
      '';
    const code = source.match(/\/qzone\/em\/(e\d+)\.(?:gif|png)/i)?.[1];
    if (code) image.replaceWith(`[em]${code}[/em]`);
  }
  let repost: ReturnType<typeof projectQzoneFeed>['repost'] = null;
  if (allowRepost) {
    const hint = [
      ...doc.querySelectorAll('[data-origtid], [data-origuin], [data-typeid="5"]'),
    ].find(
      (node) =>
        [node.getAttribute('data-origtid'), node.getAttribute('data-origuin')].some(
          (value) => value && value !== '0',
        ) || node.getAttribute('data-typeid') === '5',
    );
    const quoteText = hint
      ? [...doc.querySelectorAll('.txt-box')].find((node) => node.querySelector('a.nickname'))
      : null;
    // feeds3 puts the original author's text and pictures in sibling nodes of this block.
    const quote =
      doc.querySelector('.f-quote, .f-quote-wrap, .f-original, .f-forward-content') ||
      quoteText?.closest('.f-ct-txtimg, .fui-txtimg-bg') ||
      quoteText;
    if (quote) {
      const author = quote.querySelector('a.nickname, [data-uin]');
      const nickname = author?.textContent?.trim() ?? '';
      const uin =
        hint?.getAttribute('data-origuin') ||
        author?.getAttribute('data-uin') ||
        author
          ?.getAttribute('href')
          ?.match(/(?:https?:)?\/\/user\.qzone\.qq\.com\/([1-9]\d{4,19})(?:\b|\/)/)?.[1] ||
        '';
      const copy = quote.cloneNode(true) as Element;
      copy.querySelector('a.nickname')?.remove();
      const body = projectQzoneFeed(copy.outerHTML, false);
      const originalTid =
        [...doc.querySelectorAll('[data-origtid]')]
          .map((node) => node.getAttribute('data-origtid')?.trim() ?? '')
          .find((value) => value && value !== '0') ?? '';
      repost = {
        tid: originalTid !== '0' && /^[a-zA-Z0-9_-]{1,128}$/.test(originalTid) ? originalTid : '',
        uin,
        nickname,
        content: body.text.replace(/^[：:\s]+/, ''),
        images: body.images,
        videos: [],
      };
      quote.remove();
    }
  }
  const advertisement = Boolean(doc.querySelector('[data-tid="advertisement_app"]'));
  const feedAttrs = doc.querySelector('[data-fkey], [data-tid]');
  const rawTid = feedAttrs?.getAttribute('data-tid');
  const tid =
    feedAttrs?.getAttribute('data-fkey') ||
    (rawTid && /^\d+$/.test(rawTid)
      ? doc.querySelector('[data-key]')?.getAttribute('data-key') || rawTid
      : rawTid) ||
    null;
  const countText = (selector: string, pattern: RegExp): number | null => {
    for (const node of doc.querySelectorAll(selector)) {
      const match = (node.textContent ?? '').match(pattern);
      if (match && Number.isSafeInteger(Number(match[1]))) return Number(match[1]);
    }
    return null;
  };
  const counterSource = doc.querySelector(
    '.qz_like_btn_v3[data-curkey], .qz_like_prase[data-curkey]',
  );
  const rawCounterKey = counterSource?.getAttribute('data-curkey')?.trim() ?? '';
  const counterKey = qzoneLinkTarget(rawCounterKey) ? rawCounterKey : null;
  const rawLikes = counterSource?.getAttribute('data-likecnt');
  const likeCount =
    (rawLikes && /^\d+$/.test(rawLikes) && Number.isSafeInteger(Number(rawLikes))
      ? Number(rawLikes)
      : null) ??
    countText('.user-list', /(\d+)\s*人(?:觉得很赞|赞过|赞)/) ??
    countText('.f-op', /(?:点赞|赞)\s*[（(]?\s*(\d+)/);
  const commentCount = countText(
    '.qz_btn_reply, .f-op, .f-op-detail, .f-reply',
    /评论\s*[（(]?\s*(\d+)/,
  );
  const forwardCount =
    [...doc.querySelectorAll('.f-op a, .f-op button, .f-op span')]
      .map((node) => node.textContent?.trim() ?? '')
      .map((text) => text.match(/^(?:转发|被转发)\s*[（(]?\s*(\d+)\s*[）)]?$/)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .find((value) => Number.isSafeInteger(value) && value >= 0) ?? null;
  // Preserve official mention targets before flattening HTML into safe text.
  for (const anchor of doc.querySelectorAll('a')) {
    const label = anchor.textContent?.trim() ?? '';
    if (
      /^(?:查看详情|详情|全文|展开全文)$/.test(label) ||
      /功能内测中|内容暂不支持查看/.test(label)
    ) {
      anchor.remove();
      continue;
    }
    if (!label.startsWith('@')) continue;
    const uin =
      anchor.getAttribute('data-uin') ||
      anchor
        .getAttribute('href')
        ?.match(/(?:https?:)?\/\/user\.qzone\.qq\.com\/(\d+)(?:\b|\/)/)?.[1];
    if (uin && /^[1-9]\d{4,19}$/.test(uin))
      anchor.replaceWith(`@{uin:${uin},nick:${label.slice(1)}}`);
  }
  for (const element of doc.querySelectorAll(
    'script, style, iframe, object, embed, svg, math, template, form, input, button, textarea, link, meta, base, .f-logs, .f-reply, .f-reply-wrap, .f-op, .f-detail, .comments-list, .user-list, .f-user-info',
  ))
    element.remove();
  for (const element of doc.querySelectorAll(
    '.f-single-head, .f-single-foot, .mod-comments, .user-info, .user-pto, .user-avatar, .f-single-top',
  ))
    element.remove();
  const body =
    doc.querySelector('.f-content, .f-single-content') ?? doc.querySelector('.f-item') ?? doc.body;
  const textBody = body.querySelector('.f-info') ?? body.querySelector('.txt-box') ?? body;
  const cards = new Map<string, { href: string; text: string; cover?: string }>();
  const cardImages = new Set<string>();
  const pictureLinks = new WeakSet<Element>();
  for (const anchor of body.querySelectorAll('a[href]')) {
    const image = anchor.querySelector('img');
    if (!image) continue;
    const href = qzoneLinkTarget(anchor.getAttribute('href')!);
    const cover = qzoneMediaSource(
      image.getAttribute('data-src') ||
        image.getAttribute('lz-src') ||
        image.getAttribute('src') ||
        '',
    );
    // Qzone wraps ordinary photos in links to its own photo viewer, not just mood permalinks.
    // Keep those anchors as pictures even when the destination has no file extension.
    const destination = href ? new URL(href) : null;
    const mediaDestination =
      destination &&
      (destination.hostname === 'user.qzone.qq.com' ||
        (destination.hostname === 'h5.qzone.qq.com' &&
          /\/photo\/?$/.test(destination.pathname) &&
          (destination.searchParams.has('picKey') || destination.searchParams.has('topicId'))) ||
        /\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(href!));
    if (href && (isQzoneFeedNavigation(anchor, href) || mediaDestination)) {
      pictureLinks.add(anchor);
      continue;
    }
    if (!href || !cover) continue;
    const text =
      anchor.getAttribute('title')?.trim() ||
      anchor.textContent?.trim() ||
      image.getAttribute('alt')?.trim() ||
      new URL(href).hostname;
    cards.set(href, { href, text, cover });
    cardImages.add(cover);
    anchor.remove();
  }
  const images = new Set<string>();
  for (const image of body.querySelectorAll('img')) {
    const source = qzoneMediaSource(
      image.getAttribute('data-src') ||
        image.getAttribute('lz-src') ||
        image.getAttribute('src') ||
        '',
    );
    if (
      source &&
      !cardImages.has(source) &&
      !/qlogo|\/qzone\/em\/|\/qzone\/space\//.test(source) &&
      !source.startsWith('https://user.qzone.qq.com/')
    )
      images.add(source);
    if (image.getAttribute('alt')) image.replaceWith(image.getAttribute('alt')!);
  }
  const links = cards;
  for (const link of body.querySelectorAll('a[href]')) {
    try {
      const href = qzoneLinkTarget(link.getAttribute('href')!);
      if (!href || pictureLinks.has(link) || isQzoneFeedNavigation(link, href)) continue;
      const text = link.textContent?.trim() ?? '';
      if (
        !text ||
        /^(?:查看详情|详情|全文|展开全文)$/.test(text) ||
        /功能内测中|内容暂不支持查看/.test(text)
      ) {
        link.remove();
        continue;
      }
      links.set(href, { href, text });
    } catch {
      /* Invalid remote link is omitted. */
    }
  }
  for (const br of textBody.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of textBody.querySelectorAll('p, div, li')) block.append('\n');
  return {
    text: (textBody.textContent ?? '')
      .split('\n')
      .map((line) => line.replace(/[\t ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    images: [...images].filter((source) => !repost?.images.includes(source)),
    links: [...links.values()],
    tid,
    likeCount,
    commentCount,
    counterKey,
    forwardCount,
    advertisement,
    unsupported,
    repost,
  };
}

export function mergeQzonePosts<T extends { tid: string }>(old: T[], next: T[]): T[] {
  const values = new Map(old.map((post) => [post.tid, post]));
  for (const post of next) if (post.tid) values.set(post.tid, post);
  return [...values.values()];
}

export type QzoneTextPart = { offset: number } & (
  | { kind: 'text'; text: string }
  | { kind: 'mention'; uin: string; text: string }
  | { kind: 'emoji'; code: string }
);

/** Decode known Qzone tokens as data; no remote HTML is rendered. */
export function qzoneTextParts(content: string): QzoneTextPart[] {
  const parts: QzoneTextPart[] = [];
  const pattern = /@\{uin:([1-9]\d{4,19}),nick:([^}]*?)\}|\[em\](e\d+)\[\/em\]/g;
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index!;
    if (index > cursor)
      parts.push({ kind: 'text', text: content.slice(cursor, index), offset: cursor });
    if (match[3]) parts.push({ kind: 'emoji', code: match[3], offset: index });
    else {
      const nickname = match[2]!.replace(/,(?:who|type|uin):.*$/, '');
      parts.push({
        kind: 'mention',
        uin: match[1]!,
        text: `@${nickname || match[1]}`,
        offset: index,
      });
    }
    cursor = index + match[0].length;
  }
  if (cursor < content.length)
    parts.push({ kind: 'text', text: content.slice(cursor), offset: cursor });
  return parts;
}
