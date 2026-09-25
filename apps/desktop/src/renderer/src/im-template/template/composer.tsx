// @ts-nocheck
import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { parseMessageParts } from './emojiPacks';
import type { EmojiItem } from './emojiPacks';
import { cn } from './classNames';
import { elementLabel, elementPreviewSrc, tokenToElement } from './draftElements';

export type ComposerMentionTrigger = {
  start: number;
  end: number;
  query: string;
};

export function insertComposerNode(editor: HTMLElement, node: Node, savedRange: Range | null) {
  editor.focus();

  const range = getComposerRange(editor, savedRange);
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function getComposerRange(editor: HTMLElement, savedRange: Range | null) {
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const activeRange = selection.getRangeAt(0);
    if (
      isNodeInside(editor, activeRange.startContainer) &&
      isNodeInside(editor, activeRange.endContainer)
    ) {
      return activeRange;
    }
  }

  if (
    savedRange &&
    isNodeInside(editor, savedRange.startContainer) &&
    isNodeInside(editor, savedRange.endContainer)
  ) {
    return savedRange.cloneRange();
  }

  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}

export function focusComposerEnd(editor: HTMLElement | null) {
  if (!editor) {
    return;
  }

  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function serializeComposer(editor: HTMLElement) {
  return serializeComposerNode(editor)
    .replace(/\u200b/g, '')
    .slice(0, 4000);
}

export function getActiveComposerMentionTrigger(
  editor: HTMLElement,
  savedRange: Range | null,
): ComposerMentionTrigger | null {
  const range = getReadableComposerRange(editor, savedRange);
  if (!range) {
    return null;
  }

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(editor);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const before = serializeComposerNode(beforeRange.cloneContents()).replace(/\u200b/g, '');
  const match = /(^|[\s\n])@([^\s@\n]{0,40})$/u.exec(before);
  if (!match) {
    return null;
  }

  const query = match[2] ?? '';
  return {
    start: before.length - query.length - 1,
    end: before.length,
    query,
  };
}

export function replaceComposerTextRange(
  editor: HTMLElement,
  start: number,
  end: number,
  nodes: Node[],
) {
  editor.focus();

  const startPosition = resolveComposerTextOffset(editor, start);
  const endPosition = resolveComposerTextOffset(editor, end);
  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  range.deleteContents();

  nodes.forEach((node) => {
    range.insertNode(node);
    range.setStartAfter(node);
  });
  range.collapse(true);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function restoreComposer(editor: HTMLElement, value: string) {
  editor.replaceChildren();

  for (const part of parseMessageParts(value)) {
    if (part.type === 'text') {
      appendText(editor, part.value);
      continue;
    }

    if (part.type === 'element') {
      appendElementChip(editor, part.raw);
      continue;
    }

    appendEmojiToken(editor, part);
  }
}

/**
 * 渲染一枚元素 chip —— 草稿里那些输入框表达不了的元素（图片 / 视频 / 文件 /
 * markdown / ark / 引用…）。
 *
 * 有预览图的（图片 / 系统表情）直接画成图，跟用户当次插进来时的形态一致 —— 重放
 * 一份草稿不该把图和表情退化成 `[图片]` / `[表情]` 的文字。其余元素仍然是文字标签。
 * 两种形态都把可无损还原的 token 存在 `dataset.chatToken` 上，序列化时原样取回。
 */
function appendElementChip(editor: HTMLElement, raw: string) {
  const element = tokenToElement(raw);
  const label = element ? elementLabel(element) : '[消息]';
  const src = element ? elementPreviewSrc(element) : null;

  if (src) {
    const image = document.createElement('img');
    image.src = src;
    image.alt = label;
    image.title = label;
    image.draggable = false;
    image.dataset.chatToken = raw;
    image.className = cn('composer-token-image composer-inline-attachment');
    // 预览地址拿不到图（比如本会话里 blob: 地址已随刷新失效）就退回文字 chip，
    // 别在输入框里留一枚破图。
    image.onerror = () => image.replaceWith(elementChipNode(raw, label));
    editor.append(image);
    return;
  }

  editor.append(elementChipNode(raw, label));
}

/** 元素 chip 的纯文本形态（没有 / 取不到预览图时用）。 */
function elementChipNode(raw: string, label: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = cn('composer-element-token');
  chip.contentEditable = 'false';
  chip.dataset.chatToken = raw;
  chip.title = label;
  chip.textContent = label;
  return chip;
}

/** 表情 token：有预览图的走 <img>，字符表情直接插字形文本。 */
function appendEmojiToken(editor: HTMLElement, part: { item: EmojiItem; raw: string }) {
  const item = part.item as {
    src: string | null;
    name: string;
    glyph: string;
    large: boolean;
  };

  if (!item.src) {
    editor.append(document.createTextNode(item.glyph || item.name));
    return;
  }

  const image = document.createElement('img');
  image.src = item.src;
  image.alt = item.name;
  image.title = item.name;
  image.draggable = false;
  image.dataset.chatToken = part.raw;
  image.className = cn(
    item.large
      ? 'composer-token-image composer-sticker-token'
      : 'composer-token-image composer-inline-emoji',
  );
  editor.append(image);
}

function serializeComposerNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }

  if (node instanceof DocumentFragment) {
    return Array.from(node.childNodes).map(serializeComposerNode).join('');
  }

  if (node instanceof HTMLImageElement) {
    return node.dataset.chatToken ?? '';
  }

  if (node instanceof HTMLBRElement) {
    return '\n';
  }

  if (!(node instanceof HTMLElement)) {
    return '';
  }

  if (node.dataset.chatMention) {
    return node.dataset.chatMention;
  }

  return Array.from(node.childNodes).map(serializeComposerNode).join('');
}

function getReadableComposerRange(editor: HTMLElement, savedRange: Range | null) {
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const activeRange = selection.getRangeAt(0);
    if (
      isNodeInside(editor, activeRange.startContainer) &&
      isNodeInside(editor, activeRange.endContainer)
    ) {
      return activeRange.cloneRange();
    }
  }

  if (
    savedRange &&
    isNodeInside(editor, savedRange.startContainer) &&
    isNodeInside(editor, savedRange.endContainer)
  ) {
    return savedRange.cloneRange();
  }

  return null;
}

function resolveComposerTextOffset(editor: HTMLElement, offset: number) {
  const target = Math.max(0, offset);
  let current = 0;

  function walk(node: Node): { node: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\u200b/g, '');
      const next = current + text.length;
      if (target <= next) {
        return {
          node,
          offset: Math.max(0, Math.min(node.textContent?.length ?? 0, target - current)),
        };
      }
      current = next;
      return null;
    }

    const atomicText = composerAtomicText(node);
    if (atomicText !== null) {
      if (target <= current) {
        return nodeBoundaryPosition(node, 'before');
      }
      current += atomicText.length;
      if (target <= current) {
        return nodeBoundaryPosition(node, 'after');
      }
      return null;
    }

    for (const child of Array.from(node.childNodes)) {
      const result = walk(child);
      if (result) {
        return result;
      }
    }

    return null;
  }

  return (
    walk(editor) ?? {
      node: editor,
      offset: editor.childNodes.length,
    }
  );
}

function composerAtomicText(node: Node) {
  if (node instanceof HTMLImageElement) {
    return node.dataset.chatToken ?? '';
  }
  if (node instanceof HTMLBRElement) {
    return '\n';
  }
  if (node instanceof HTMLElement && node.dataset.chatMention) {
    return node.dataset.chatMention;
  }
  return null;
}

function nodeBoundaryPosition(node: Node, boundary: 'before' | 'after') {
  const parent = node.parentNode;
  if (!parent) {
    return {
      node,
      offset: 0,
    };
  }

  const index = Array.prototype.indexOf.call(parent.childNodes, node) as number;
  return {
    node: parent,
    offset: boundary === 'before' ? index : index + 1,
  };
}

function appendText(editor: HTMLElement, value: string) {
  const lines = value.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) {
      editor.append(document.createElement('br'));
    }
    if (line) {
      editor.append(document.createTextNode(line));
    }
  });
}

export function isNodeInside(parent: Node, child: Node) {
  return parent === child || parent.contains(child);
}

export function ComposerResizeHandle({
  height,
  onHeightChange,
  minHeight = 150,
  maxHeight = 340,
}: {
  height: number;
  onHeightChange: (height: number) => void;
  /** 可拖拽的下限 / 上限（默认值跟 chatPane 的 loadLayoutNumber 夹取范围保持一致）。 */
  minHeight?: number;
  maxHeight?: number;
}) {
  const startY = useRef(0);
  const startHeight = useRef(height);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    startY.current = event.clientY;
    startHeight.current = height;
    document.body.classList.add('is-resizing-composer');

    function handlePointerMove(moveEvent: globalThis.PointerEvent) {
      onHeightChange(
        clamp(startHeight.current - (moveEvent.clientY - startY.current), minHeight, maxHeight),
      );
    }

    function handlePointerUp() {
      document.body.classList.remove('is-resizing-composer');
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    }

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }

  return (
    <div
      className={cn('composer-resize')}
      role="separator"
      aria-label="调整输入框高度"
      aria-orientation="horizontal"
      onPointerDown={handlePointerDown}
    />
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
