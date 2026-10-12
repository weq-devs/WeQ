import { createElement, useMemo, type ReactNode } from 'react';
import { openLightbox } from './ImageLightbox';
import { collectionImageUrl } from '../lib/resourceUrl';

const DROP_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'embed',
  'svg',
  'math',
  'template',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
]);
const TEXT_TAGS = new Set([
  'p',
  'div',
  'span',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'hr',
]);

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function imageUrl(value: string | null): string | null {
  const href = httpUrl(value);
  if (!href) return null;
  const url = new URL(href);
  if (url.port) return null;
  const domains = ['qpic.cn', 'qq.com', 'gtimg.cn', 'gtimg.com', 'weiyun.com'];
  return domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
    ? collectionImageUrl(href)
    : null;
}

/** Parse into an inert document, then build React nodes without source attributes. */
function contentNode(node: Node, key: string, depth = 0): ReactNode {
  if (depth > 64) return null;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (DROP_TAGS.has(tag)) return null;
  const children = Array.from(element.childNodes).map((child, index) =>
    contentNode(child, `${key}-${index}`, depth + 1),
  );
  if (tag === 'a') {
    const href = httpUrl(element.getAttribute('href'));
    return href ? (
      <a key={key} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span key={key}>{children}</span>
    );
  }
  if (tag === 'img') {
    const src = imageUrl(element.getAttribute('src'));
    const alt = element.getAttribute('alt') || '收藏图片';
    return src ? (
      <button
        key={key}
        type="button"
        className="weq-col-detail-image"
        onClick={() => openLightbox(src, alt)}
      >
        <img src={src} alt={alt} loading="lazy" />
      </button>
    ) : (
      <span key={key} className="weq-col-detail-unavailable">
        [图片]
      </span>
    );
  }
  if (['object', 'audio', 'video', 'source'].includes(tag)) {
    return (
      <span key={key} className="weq-col-detail-unavailable">
        [{tag === 'audio' ? '语音' : tag === 'video' ? '视频' : '附件'}]
      </span>
    );
  }
  if (!TEXT_TAGS.has(tag)) return <span key={key}>{children}</span>;
  if (tag === 'br' || tag === 'hr') return createElement(tag, { key });
  return createElement(tag, { key }, children);
}

export function collectionContentText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const tag of DROP_TAGS) {
    for (const element of doc.querySelectorAll(tag)) element.remove();
  }
  for (const element of doc.querySelectorAll('br')) element.replaceWith('\n');
  for (const element of doc.querySelectorAll('p, div, li')) element.append('\n');
  return (doc.body.textContent ?? '').trim();
}

export function CollectionContent({
  content,
  format,
}: {
  content: string;
  format: 'text' | 'html';
}) {
  const body = useMemo(() => {
    if (format === 'text') return content;
    const doc = new DOMParser().parseFromString(content, 'text/html');
    return Array.from(doc.body.childNodes).map((node, index) => contentNode(node, String(index)));
  }, [content, format]);
  return (
    <div className={`weq-col-detail-content${format === 'text' ? ' is-text' : ''}`}>{body}</div>
  );
}
