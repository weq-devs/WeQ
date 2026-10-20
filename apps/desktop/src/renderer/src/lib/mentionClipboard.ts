import type { RepeatElement } from './messageRepeat';
import { messageContentClipboard } from './messageClipboard';

const UID = /^(?:all|u_[A-Za-z0-9_-]+)$/;

/** 只读取身份和纯文字，不恢复任意 HTML、事件、图片或外部资源。 */
export function readMentionClipboard(html: string): RepeatElement[] | null {
  if (!html || html.length > 2_000_000) return null;
  const root = new DOMParser().parseFromString(html, 'text/html').body;
  const result: RepeatElement[] = [];
  let mentions = 0;
  const append = (value: string) => {
    if (!value) return;
    const last = result.at(-1);
    if (last?.type === 'text')
      last.data!.textContent = String(last.data?.textContent ?? '') + value;
    else result.push({ type: 'text', data: { textContent: value } });
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent ?? '');
      return;
    }
    if (!(node instanceof Element) || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName))
      return;
    const uid = node.getAttribute('data-weq-at-uid') ?? '';
    const uin = node.getAttribute('data-weq-at-uin') ?? '';
    if (UID.test(uid) || (!uid && /^\d{1,12}$/.test(uin))) {
      mentions++;
      result.push({
        type: 'at',
        data: {
          textContent: node.textContent ?? '',
          ...(uid ? { atTargetUid: uid } : {}),
          ...(/^\d{1,12}$/.test(uin) ? { atTargetUin: Number(uin) } : {}),
          ...(uid === 'all' ? { all: true } : {}),
        },
      });
      return;
    }
    if (node.tagName === 'BR') {
      append('\n');
      return;
    }
    if (node.tagName === 'BLOCKQUOTE') {
      append(
        `${result.length ? '\n' : ''}${(node.textContent ?? '')
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}\n`,
      );
      return;
    }
    if (['DIV', 'P', 'LI'].includes(node.tagName) && result.length) append('\n');
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return mentions ? result : null;
}

export function mentionClipboardHtml(
  elements: RepeatElement[],
): { text: string; html: string } | null {
  if (!elements.some((element) => element.type === 'at')) return null;
  return messageContentClipboard(elements);
}

export async function writeMentionClipboard(value: {
  text: string;
  html: string;
}): Promise<boolean> {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([value.text], { type: 'text/plain' }),
          'text/html': new Blob([value.html], { type: 'text/html' }),
        }),
      ]);
      return true;
    }
  } catch {
    /* 非安全 Web 上使用用户触发的 copy 事件。 */
  }
  const listener = (event: ClipboardEvent) => {
    event.clipboardData?.setData('text/plain', value.text);
    event.clipboardData?.setData('text/html', value.html);
    event.preventDefault();
  };
  document.addEventListener('copy', listener);
  try {
    return document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', listener);
  }
}
