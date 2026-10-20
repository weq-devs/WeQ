import type { RepeatElement } from './messageRepeat';
import { UNICODE_FACE_MAP } from '../components/unicodeFaceMap';

export interface MessageClipboard {
  text: string;
  html: string;
}

const LABELS: Record<string, string> = {
  pic: '[图片]',
  mface: '[表情包]',
  video: '[视频]',
  bubbleVideo: '[视频]',
  ptt: '[语音]',
  file: '[文件]',
  onlineFile: '[文件]',
  onlineFolder: '[文件夹]',
  ark: '[卡片]',
  forward: '[聊天记录]',
  multiMsg: '[聊天记录]',
  markdown: '[Markdown]',
};
function label(element: RepeatElement): string {
  const data = element.data ?? {};
  if (element.type === 'face')
    return (
      UNICODE_FACE_MAP[Number(data.faceId)] || String(data.faceText || `[表情${data.faceId ?? ''}]`)
    );
  if (element.type === 'mface') return String(data.faceName || data.faceText || LABELS.mface);
  if (element.type === 'file' || element.type === 'onlineFile')
    return `${LABELS.file}${data.fileName ? ` ${String(data.fileName)}` : ''}`;
  return String(
    data.textContent ?? data.content ?? data.summary ?? LABELS[element.type ?? ''] ?? '',
  );
}
function originalText(element: RepeatElement, depth: number): string {
  const data = element.data ?? {};
  return (
    messageContentText(
      Array.isArray(data.origElements) ? (data.origElements as RepeatElement[]) : [],
      '',
      depth + 1,
    ) || String(data.origText || '引用消息')
  );
}

/** 纯文本与富文本共用内容来源，不用会话摘要替代真实引用或混排元素。 */
export function messageContentText(
  elements: readonly RepeatElement[] = [],
  fallback = '',
  depth = 0,
): string {
  if (depth > 8) return '[引用消息]';
  const quotes = elements
    .filter((el) => el.type === 'reply')
    .map((el) =>
      originalText(el, depth)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    );
  const body =
    elements
      .filter((el) => el.type !== 'reply')
      .map(label)
      .join('') || fallback;
  return [...quotes, body].filter(Boolean).join('\n');
}

export function messageContentClipboard(
  elements: readonly RepeatElement[] = [],
  fallback = '',
): MessageClipboard {
  const root = document.createElement('div');
  root.style.whiteSpace = 'pre-wrap';
  for (const element of elements) {
    if (element.type !== 'reply') continue;
    const quote = document.createElement('blockquote');
    quote.textContent = originalText(element, 0);
    root.append(quote);
  }
  const body = document.createElement('span');
  for (const element of elements) {
    if (element.type === 'reply') continue;
    const span = document.createElement('span');
    span.textContent = label(element);
    const data = element.data ?? {};
    if (element.type === 'at') {
      if (typeof data.atTargetUid === 'string') span.dataset.weqAtUid = data.atTargetUid;
      if (data.atTargetUin != null) span.dataset.weqAtUin = String(data.atTargetUin);
    }
    body.append(span);
  }
  if (!body.textContent) body.textContent = fallback;
  body.style.whiteSpace = 'pre-wrap';
  root.append(body);
  return { text: messageContentText(elements, fallback), html: root.outerHTML };
}

/** 只拷贝可见语义：表情转替代文字，引用保留块，不复制资源票据、动画或操作控件。 */
export function messageNodeClipboard(source: Node): MessageClipboard {
  const root = document.createElement('div');
  root.style.whiteSpace = 'pre-wrap';
  const joinParts = (parts: string[]): string =>
    parts.reduce(
      (text, part) =>
        text.endsWith('\n') && part.startsWith('\n') ? text + part.slice(1) : text + part,
      '',
    );
  const visit = (node: Node, target: HTMLElement): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(node.textContent ?? ''));
      return node.textContent ?? '';
    }
    if (!(node instanceof Element))
      return joinParts(Array.from(node.childNodes).map((child) => visit(child, target)));
    if (
      ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'BUTTON', 'INPUT', 'TEXTAREA'].includes(
        node.tagName.toUpperCase(),
      ) ||
      node.getAttribute('aria-hidden') === 'true'
    )
      return '';
    if (node.tagName === 'IMG' || node.getAttribute('role') === 'img') {
      const text = node.classList.contains('face-emoji-unicode')
        ? (node.textContent ?? '')
        : node.getAttribute('alt') || node.getAttribute('aria-label') || '[图片]';
      target.append(document.createTextNode(text));
      return text;
    }
    if (node.tagName === 'BR') {
      target.append(document.createElement('br'));
      return '\n';
    }
    const quote = node.tagName === 'BLOCKQUOTE' || node.classList.contains('qq-reply-quote');
    const block = quote || ['DIV', 'P', 'LI', 'SECTION', 'PRE'].includes(node.tagName);
    const out = document.createElement(quote ? 'blockquote' : block ? 'div' : 'span');
    for (const name of ['data-weq-at-uid', 'data-weq-at-uin']) {
      const value = node.getAttribute(name);
      if (
        value &&
        (name.endsWith('uid') ? /^(?:all|u_[A-Za-z0-9_-]+)$/.test(value) : /^\d{1,12}$/.test(value))
      )
        out.setAttribute(name, value);
    }
    const raw = joinParts(Array.from(node.childNodes).map((child) => visit(child, out)));
    const text = block ? raw.replace(/^\n+|\n+$/g, '') : raw;
    target.append(out);
    if (quote)
      return `\n${text
        .replace(/^\n+|\n+$/g, '')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n`;
    return block ? `\n${text}\n` : text;
  };
  const text = visit(source, root)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
  return { text, html: root.outerHTML };
}

export function selectedMessageClipboard(scope?: Element | null): MessageClipboard | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (scope && (!scope.contains(range.startContainer) || !scope.contains(range.endContainer)))
      return null;
    const ancestor =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const image = ancestor?.closest('[role="img"]');
    const quote = ancestor?.closest('.qq-reply-quote, blockquote');
    if (image) fragment.append(image.cloneNode(true));
    else if (quote) {
      const block = document.createElement('blockquote');
      block.append(range.cloneContents());
      fragment.append(block);
    } else fragment.append(range.cloneContents());
  }
  const value = messageNodeClipboard(fragment);
  return value.text ? value : null;
}

export function messageRichClipboard(
  rows: readonly {
    sender: string;
    time: string;
    body: string;
    elements?: RepeatElement[];
  }[],
): { text: string; html: string } {
  const root = document.createElement('div');
  const texts: string[] = [];
  for (const row of rows) {
    const section = document.createElement('section');
    const header = document.createElement('p');
    const name = document.createElement('strong');
    name.textContent = row.sender;
    const time = document.createElement('small');
    time.textContent = ` ${row.time}`;
    header.append(name, time);
    section.append(header);
    const content = messageContentClipboard(row.elements, row.body);
    const body = document.createElement('div');
    body.innerHTML = content.html;
    section.append(body);
    root.append(section);
    texts.push(`${row.sender} ${row.time}\n${content.text}`);
  }
  return { text: texts.join('\n\n'), html: root.outerHTML };
}
