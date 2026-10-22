import { messageNodeClipboard } from '../../lib/messageClipboard';
import { restoreComposer, serializeComposer } from './composer';
import { createMediaId, type ComposerAttachment } from './composerMedia';
import { elementToToken, tokenToElement } from './draftElements';

type ComposerClipboard = {
  id: string;
  body: string;
  images: ComposerAttachment[];
};

// 只保留最近一次输入框复制的文件本体；粘贴时重建 URL，不依赖原会话的预览生命周期。
let latest: ComposerClipboard | null = null;

export function writeComposerClipboard(
  editor: HTMLElement,
  data: DataTransfer,
  images: readonly ComposerAttachment[],
): Range | null {
  const selection = editor.ownerDocument.defaultView?.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  const holder = editor.ownerDocument.createElement('div');
  holder.append(range.cloneContents());
  if (!holder.querySelector('img[data-chat-token]')) return null;
  const body = serializeComposer(holder);
  if (!body) return null;
  const id = createMediaId('clipboard');
  const urls = new Set(Array.from(holder.querySelectorAll('img'), (image) => image.src));
  const snapshot = { id, body, images: images.filter((image) => image.url && urls.has(image.url)) };
  const plain = messageNodeClipboard(holder).text;
  // 对外仅输出可见内容，不暴露内部元素 token，也不从外来 HTML 恢复它们。
  const html = editor.ownerDocument.createElement('div');
  html.dataset.weqComposerClipboard = id;
  html.style.whiteSpace = 'pre-wrap';
  const append = (node: Node, target: HTMLElement): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(node.textContent ?? '');
    } else if (node instanceof HTMLImageElement) {
      const image = editor.ownerDocument.createElement('img');
      image.src = node.src;
      image.alt = node.alt;
      target.append(image);
    } else if (node instanceof HTMLBRElement) {
      target.append(editor.ownerDocument.createElement('br'));
    } else {
      node.childNodes.forEach((child) => {
        append(child, target);
      });
    }
  };
  holder.childNodes.forEach((node) => {
    append(node, html);
  });
  data.setData('text/plain', plain);
  data.setData('text/html', html.outerHTML);
  latest = snapshot;
  return range;
}

export function readComposerClipboard(data: DataTransfer): ComposerClipboard | null {
  const html = data.getData('text/html');
  if (!latest || !html || html.length > 2_000_000) return null;
  const root = new DOMParser().parseFromString(html, 'text/html');
  return root
    .querySelector('[data-weq-composer-clipboard]')
    ?.getAttribute('data-weq-composer-clipboard') === latest.id
    ? latest
    : null;
}

export function composerClipboardFragment(
  snapshot: ComposerClipboard,
  images: readonly ComposerAttachment[],
): DocumentFragment {
  const holder = document.createElement('div');
  restoreComposer(holder, snapshot.body);
  for (const node of holder.querySelectorAll('img')) {
    const index = snapshot.images.findIndex((image) => image.url === node.src);
    const replacement = images[index];
    if (!replacement?.url) continue;
    node.src = replacement.url;
    // 保留原元素的其余字段，只替换已释放的本地预览地址。
    const element = tokenToElement(node.dataset.chatToken ?? '');
    if (element && typeof element === 'object') {
      node.dataset.chatToken = elementToToken({ ...element, localPreviewUrl: replacement.url });
    }
  }
  const fragment = document.createDocumentFragment();
  fragment.append(...holder.childNodes);
  return fragment;
}
