import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { MESSAGE_IMAGE_WINDOW_PREFIX } from '../../../shared/message_image';
import { MessageImageContext } from '../lib/messageImageContext';
import { RenderDocumentContext } from '../lib/renderDocument';
import { IS_ELECTRON } from '../lib/target.shared';

export function messageImageAvailable() {
  return IS_ELECTRON && Boolean(window.weq?.capture?.messageImage);
}

function copyStyles(source: Document, target: Document) {
  target.body.className = source.body.className;
  Object.assign(target.body.style, { margin: '0', overflow: 'visible' });
  const base = target.createElement('base');
  base.href = source.baseURI;
  const still = target.createElement('style');
  still.textContent = `
    *, *::before, *::after { animation-play-state: paused !important; transition: none !important; }
    :root { overflow: visible !important; }
  `;
  target.head.append(base, still);
  const copies = new Map<Element, Element>();
  const sync = () => {
    const root = target.documentElement;
    for (const { name } of Array.from(root.attributes))
      if (!source.documentElement.hasAttribute(name)) root.removeAttribute(name);
    for (const { name, value } of source.documentElement.attributes)
      if (root.getAttribute(name) !== value) root.setAttribute(name, value);
    const current = new Set(source.head.querySelectorAll('style, link[rel="stylesheet"]'));
    for (const [original, copy] of copies) {
      if (current.has(original)) continue;
      copies.delete(original);
      copy.remove();
    }
    // 保留节点和规则的顺序，单条装扮加载时不重新请求整页样式表。
    let previous: Element = base;
    for (const original of current) {
      let copy = copies.get(original);
      if (!copy) {
        copy = target.importNode(original, true);
        copies.set(original, copy);
      } else if (original.tagName === 'STYLE' && copy.textContent !== original.textContent) {
        copy.textContent = original.textContent;
      }
      if (copy.previousElementSibling !== previous) previous.after(copy);
      previous = copy;
    }
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(source.head, { subtree: true, childList: true, characterData: true });
  observer.observe(source.documentElement, { attributes: true });
  return () => observer.disconnect();
}

function copyBackdrop(source: HTMLElement, target: Document, viewport: DOMRect, pane: DOMRect) {
  const original = source.querySelector<HTMLElement>(':scope > .weq-chat-backdrop');
  if (!original) return null;
  const copy = target.importNode(original, true);
  Object.assign(copy.style, {
    top: `${pane.top - viewport.top}px`,
    left: `${pane.left - viewport.left}px`,
    width: `${pane.width}px`,
    bottom: `${viewport.bottom - pane.bottom}px`,
    minHeight: `${pane.height}px`,
  });
  const video = original.querySelector('video');
  const clone = copy.querySelector('video');
  const media = copy.querySelector<HTMLElement>('.weq-chat-backdrop-media');
  const wallpaper = media?.style.backgroundImage.match(/^url\("(.*)"\)$/)?.[1];
  if (media && wallpaper) {
    // 保持屏幕上 cover 的实际缩放和裁切位置，长图向下延续同一比例的底图。
    const image = target.createElement('img');
    media.setAttribute('data-weq-message-image-pending', '');
    image.src = wallpaper;
    void image
      .decode()
      .then(() => keepBackdropScale(media, pane, image.naturalWidth, image.naturalHeight))
      .catch(() => undefined)
      .finally(() => media.removeAttribute('data-weq-message-image-pending'));
  }
  if (video && clone) {
    // 固定点击时的视频画面，整张长图的各段不会取到不同时间的背景。
    const canvas = target.createElement('canvas');
    canvas.className = clone.className;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    clone.replaceWith(canvas);
    if (canvas.width && canvas.height && media && video.readyState >= 2) {
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      media.setAttribute('data-weq-message-image-pending', '');
      try {
        canvas.toBlob((blob) => {
          media.removeAttribute('data-weq-message-image-pending');
          if (!blob || !media.isConnected || !target.defaultView) return;
          media.style.backgroundImage = `url("${target.defaultView.URL.createObjectURL(blob)}")`;
          keepBackdropScale(media, pane, canvas.width, canvas.height);
          canvas.remove();
        });
      } catch {
        // 跨源视频仍可直接合成到截图，只是浏览器不允许读取画布像素。
        media.removeAttribute('data-weq-message-image-pending');
      }
    }
  }
  return copy;
}

function keepBackdropScale(media: HTMLElement, pane: DOMRect, width: number, height: number) {
  if (!width || !height) return;
  const scale = Math.max(pane.width / width, pane.height / height);
  Object.assign(media.style, {
    backgroundSize: `${width * scale}px ${height * scale}px`,
    backgroundPosition: `center ${(pane.height - height * scale) / 2}px`,
    backgroundRepeat: 'repeat-y',
  });
}

function buildMessageSurface(source: HTMLElement, target: Document) {
  const owner = source.ownerDocument;
  const host = source.closest<HTMLElement>('.chat-pane, .weq-forward-window');
  const bounds = source.getBoundingClientRect();
  if (!host || !bounds.width || !bounds.height) throw new Error('聊天消息窗口不可见');
  const path: HTMLElement[] = [];
  for (let node = source.parentElement; node && node !== owner.body; node = node.parentElement)
    path.unshift(node);

  let parent = target.body as HTMLElement;
  for (const node of path) {
    const wrapper = target.importNode(node, false);
    wrapper.style.setProperty('display', 'contents', 'important');
    wrapper.classList.remove('selection-mode');
    parent.append(wrapper);
    parent = wrapper;
  }
  const pane = target.createElement('div');
  const backgroundSource = host.closest('.chat-main') ?? host;
  const backgroundRect = backgroundSource.getBoundingClientRect();
  const background = target.createElement('div');
  Object.assign(background.style, {
    position: 'absolute',
    top: `${backgroundRect.top - bounds.top}px`,
    left: `${backgroundRect.left - bounds.left}px`,
    bottom: `${bounds.bottom - backgroundRect.bottom}px`,
    width: `${backgroundRect.width}px`,
    minHeight: `${backgroundRect.height}px`,
    background: getComputedStyle(backgroundSource).background,
  });
  const backdrop = copyBackdrop(host, target, bounds, host.getBoundingClientRect());
  Object.assign(pane.style, {
    position: 'absolute',
    top: `${Math.max(0, Math.round(bounds.top))}px`,
    left: `${Math.max(0, Math.round(bounds.left))}px`,
    width: `${bounds.width}px`,
    isolation: 'isolate',
    overflow: 'hidden',
  });
  // 普通会话的滚动条留槽参与换行。照原宽度保留留槽，图片里不绘制滚动条。
  const sourceStyle = getComputedStyle(source);
  const gutter = Math.max(
    0,
    source.offsetWidth -
      source.clientWidth -
      Number.parseFloat(sourceStyle.borderLeftWidth) -
      Number.parseFloat(sourceStyle.borderRightWidth),
  );
  const rows = target.importNode(source, false);
  rows.classList.remove('is-virtualized', 'is-marquee-selecting');
  rows.removeAttribute('tabindex');
  Object.assign(rows.style, {
    position: 'relative',
    zIndex: '1',
    boxSizing: 'border-box',
    width: '100%',
    minHeight: '0',
    height: 'auto',
    maxHeight: 'none',
    overflow: 'visible',
    margin: '0',
    padding: sourceStyle.padding,
    paddingRight: `${Number.parseFloat(sourceStyle.paddingRight) + gutter}px`,
    background: sourceStyle.background,
  });
  pane.append(background);
  if (backdrop) pane.append(backdrop);
  pane.append(rows);
  parent.append(pane);
  return { pane, rows };
}

async function waitForMessageSurface(
  popup: Window,
  source: Document,
  pane: HTMLElement,
  expectedRows: number,
) {
  const target = popup.document;
  let changed = performance.now();
  const observer = new MutationObserver(() => {
    changed = performance.now();
  });
  observer.observe(pane, { subtree: true, childList: true, attributes: true, characterData: true });
  observer.observe(target.head, { subtree: true, childList: true, characterData: true });
  observer.observe(target.documentElement, { attributes: true });
  const deadline = changed + 18_000;
  try {
    while (!popup.closed && performance.now() < deadline) {
      source.fonts.forEach((face) => {
        if (face.status !== 'loaded' || target.fonts.has(face)) return;
        try {
          target.fonts.add(face);
          changed = performance.now();
        } catch {
          // 由 CSS 声明的字体用镜像样式表在目标文档自行加载。
        }
      });
      const images = Array.from(pane.querySelectorAll('img'));
      for (const image of images) if (image.loading === 'lazy') image.loading = 'eager';
      const count = pane.querySelectorAll('[data-weq-message-image-row]').length;
      if (
        count === expectedRows &&
        !pane.querySelector('[data-weq-message-image-pending]') &&
        images.every((image) => image.complete) &&
        Array.from(target.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).every(
          (link) => link.sheet,
        ) &&
        target.fonts.status === 'loaded' &&
        performance.now() - changed >= 280
      ) {
        pane.setAttribute('data-weq-message-image-ready', '');
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 70));
    }
    throw new Error('聊天画面未能完整加载，请稍后重试');
  } finally {
    observer.disconnect();
  }
}

export function useMessageImage() {
  const [capture, setCapture] = useState<{ target: HTMLElement; content: ReactNode } | null>(null);
  const popupRef = useRef<Window | null>(null);
  useEffect(() => () => popupRef.current?.close(), []);

  async function copy(source: HTMLElement, content: ReactNode, count: number) {
    const bridge = window.weq?.capture;
    if (!bridge?.messageImage) throw new Error('当前窗口不支持复制聊天长图');
    if (popupRef.current) throw new Error('正在生成聊天长图');
    if (count > 1200) throw new Error('所选消息过多，请减少选中的消息后重试');
    const sourceDocument = source.ownerDocument;
    const name = `${MESSAGE_IMAGE_WINDOW_PREFIX}${crypto.randomUUID()}`;
    const popup = sourceDocument.defaultView?.open('about:blank', name);
    if (!popup) throw new Error('无法打开聊天长图窗口');
    popupRef.current = popup;
    let stopStyles: (() => void) | undefined;
    try {
      const target = popup.document;
      // about:blank 默认处于怪异模式，排版与原应用的标准模式不同。
      target.open();
      target.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      target.close();
      stopStyles = copyStyles(sourceDocument, target);
      const { pane, rows } = buildMessageSurface(source, target);
      flushSync(() => setCapture({ target: rows, content }));
      await waitForMessageSurface(popup, sourceDocument, pane, count);
      const result = await bridge.messageImage();
      if (!result.ok) throw new Error(result.error);
    } finally {
      flushSync(() => setCapture(null));
      stopStyles?.();
      popup.close();
      popupRef.current = null;
    }
  }

  const portal = capture
    ? createPortal(
        <RenderDocumentContext.Provider value={capture.target.ownerDocument}>
          <MessageImageContext.Provider value>{capture.content}</MessageImageContext.Provider>
        </RenderDocumentContext.Provider>,
        capture.target,
      )
    : null;
  return { copy, portal, busy: Boolean(capture) };
}
