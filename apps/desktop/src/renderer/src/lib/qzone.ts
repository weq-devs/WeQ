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

export function projectQzoneFeed(html: string): {
  text: string;
  images: string[];
  links: { href: string; text: string }[];
} {
  const doc = new DOMParser().parseFromString(html, 'text/html');
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
  const unsupported = /功能内测中|内容暂不支持查看/.test(textBody.textContent ?? '');
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
      !unsupported &&
      !/qlogo|\/qzone\/em\/|\/qzone\/space\//.test(source) &&
      !source.startsWith('https://user.qzone.qq.com/')
    )
      images.add(source);
    if (image.getAttribute('alt')) image.replaceWith(image.getAttribute('alt')!);
  }
  const links = new Map<string, { href: string; text: string }>();
  for (const link of body.querySelectorAll('a[href]')) {
    try {
      const url = new URL(link.getAttribute('href')!, 'https://user.qzone.qq.com/');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        (url.hostname !== 'user.qzone.qq.com' && !url.hostname.endsWith('.qzone.qq.com'))
      )
        continue;
      links.set(url.href, { href: url.href, text: link.textContent?.trim() || '查看详情' });
    } catch {
      /* Invalid remote link is omitted. */
    }
  }
  for (const br of textBody.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of textBody.querySelectorAll('p, div, li')) block.append('\n');
  return {
    text: unsupported
      ? '这条动态暂未提供完整正文，可进入好友空间查看。'
      : (textBody.textContent ?? '')
          .split('\n')
          .map((line) => line.replace(/[\t ]+/g, ' ').trim())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim(),
    images: [...images],
    links: [...links.values()],
  };
}

export function mergeQzonePosts<T extends { tid: string }>(old: T[], next: T[]): T[] {
  const values = new Map(old.map((post) => [post.tid, post]));
  for (const post of next) if (post.tid) values.set(post.tid, post);
  return [...values.values()];
}
