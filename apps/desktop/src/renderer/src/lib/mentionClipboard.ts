import type { RepeatElement } from './messageRepeat';

const UID = /^(?:all|u_[A-Za-z0-9_-]+)$/;
const MEDIA_LABELS: Record<string, string> = {
  pic: '[图片]',
  mface: '[表情包]',
  video: '[视频]',
  ptt: '[语音]',
};

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
  const root = document.createElement('span');
  for (const element of elements) {
    const data = element.data ?? {};
    if (element.type === 'at') {
      const span = document.createElement('span');
      if (typeof data.atTargetUid === 'string') span.dataset.weqAtUid = data.atTargetUid;
      if (data.atTargetUin != null) span.dataset.weqAtUin = String(data.atTargetUin);
      span.textContent = String(data.textContent ?? '@');
      root.append(span);
    } else if (element.type !== 'reply')
      root.append(
        document.createTextNode(
          String(data.textContent ?? data.faceText ?? MEDIA_LABELS[element.type ?? ''] ?? ''),
        ),
      );
  }
  return { text: root.textContent ?? '', html: root.outerHTML };
}

export function selectedMentionClipboard(): { text: string; html: string } | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const root = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i++)
    root.append(selection.getRangeAt(i).cloneContents());
  return readMentionClipboard(root.innerHTML)
    ? { text: selection.toString(), html: root.innerHTML }
    : null;
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
