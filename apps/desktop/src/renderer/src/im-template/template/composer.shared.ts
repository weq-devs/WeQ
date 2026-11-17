import { parseMessageParts } from './emojiPacks';
import type { EmojiItem } from './emojiPacks';
import { cn } from './classNames';
import { elementLabel, elementPreviewSrc, tokenToElement } from './draftElements';
import { slashEmojiTrigger } from '../../lib/slashEmoji';

export type ComposerMentionTrigger = {
  start: number;
  end: number;
  query: string;
};

export function insertComposerNode(
  editor: HTMLElement,
  node: Node,
  savedRange: Range | null,
  focus = true,
) {
  if (focus) editor.focus();

  const range =
    !focus &&
    savedRange &&
    isNodeInside(editor, savedRange.startContainer) &&
    isNodeInside(editor, savedRange.endContainer)
      ? savedRange.cloneRange()
      : getComposerRange(editor, savedRange);
  const last = node instanceof DocumentFragment ? node.lastChild : node;
  if (!last) return;
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(last);
  range.collapse(true);

  if (focus) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return range;
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
  let remaining = 4000;
  // 长度限制只裁正文，不截断媒体 token，否则多图会丢失后半张图片的素材信息。
  return parseMessageParts(serializeComposerNode(editor).replace(/\u200b/g, ''))
    .map((part) => {
      if (part.type !== 'text') return part.raw;
      const value = part.value.slice(0, remaining);
      remaining -= value.length;
      return value;
    })
    .join('');
}

/** 标记真实换行，区别于浏览器删空 contenteditable 后留下的占位 br。 */
export function createComposerLineBreak() {
  const lineBreak = document.createElement('br');
  lineBreak.dataset.weqLineBreak = 'true';
  return lineBreak;
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
  const match = /(^|[^A-Za-z0-9_.+\-@])@([^\s@\n]{0,40})$/u.exec(before);
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

export function getActiveComposerSlashTrigger(editor: HTMLElement, savedRange: Range | null) {
  const range = getReadableComposerRange(editor, savedRange);
  if (!range) return null;
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(editor);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  return slashEmojiTrigger(
    serializeComposerNode(beforeRange.cloneContents()).replace(/\u200b/g, ''),
  );
}

export function replaceComposerTextRange(
  editor: HTMLElement,
  start: number,
  end: number,
  nodes: Node[],
  preserveUndo = false,
) {
  editor.focus();

  const startPosition = resolveComposerTextOffset(editor, start);
  const endPosition = resolveComposerTextOffset(editor, end);
  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset);
  if (preserveUndo && typeof editor.ownerDocument.execCommand === 'function') {
    const selection = editor.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const fragment = editor.ownerDocument.createElement('div');
    for (const node of nodes) fragment.append(node.cloneNode(true));
    // insertHTML 将短词替换作为一次原生编辑事务，撤销可以完整恢复 /关键词。
    if (editor.ownerDocument.execCommand('insertHTML', false, fragment.innerHTML)) return;
  }
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

  // @ 元素还原成输入框里的 mention span（带 token，可无损再往返）——而不是退化成
  // 一枚普通文字 chip，否则重放草稿会把真正的 @ 变成纯文本。
  if (element && typeof element === 'object' && 'kind' in element && element.kind === 'at') {
    const mention = document.createElement('span');
    mention.className = cn('composer-mention-token');
    mention.contentEditable = 'false';
    mention.dataset.chatMention = label;
    if ('atTargetUid' in element && typeof element.atTargetUid === 'string')
      mention.dataset.weqAtUid = element.atTargetUid;
    if ('atTargetUin' in element && element.atTargetUin != null)
      mention.dataset.weqAtUin = String(element.atTargetUin);
    mention.dataset.chatToken = raw;
    mention.textContent = label;
    editor.append(mention);
    return;
  }

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

function serializeComposerChildren(node: Node): string {
  const block = (child: Node | undefined) =>
    child instanceof HTMLElement &&
    !child.dataset.chatToken &&
    (child.tagName === 'DIV' || child.tagName === 'P');
  return Array.from(node.childNodes)
    .map((child, index, children) => {
      // 原生编辑／听写也会生成块级行；相邻空行不能因占位 br 被忽略而合并。
      const separator = index > 0 && (block(child) || block(children[index - 1])) ? '\n' : '';
      return separator + serializeComposerNode(child);
    })
    .join('');
}

function serializeComposerNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }

  if (node instanceof DocumentFragment) {
    return serializeComposerChildren(node);
  }

  if (node instanceof HTMLImageElement) {
    return node.dataset.chatToken ?? '';
  }

  if (node instanceof HTMLBRElement) {
    if (!node.dataset.weqLineBreak && node.parentNode?.lastChild === node) return '';
    return '\n';
  }

  if (!(node instanceof HTMLElement)) {
    return '';
  }

  // 带可还原 token 的元素优先（@ / 图片 / 文件…）：取回 token 而不是它的显示文字，
  // 否则 @ 的目标 uid、图片的本体都会在序列化这一步丢掉。
  if (node.dataset.chatToken) {
    return node.dataset.chatToken;
  }

  if (node.dataset.chatMention) {
    return node.dataset.chatMention;
  }

  return serializeComposerChildren(node);
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
  // 触发词偏移来自序列化正文，提及和其他元素必须按完整 token 计长。
  if (node instanceof HTMLElement && node.dataset.chatToken) {
    return node.dataset.chatToken;
  }
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
      editor.append(createComposerLineBreak());
    }
    if (line) {
      editor.append(document.createTextNode(line));
    }
  });
}

export function isNodeInside(parent: Node, child: Node) {
  return parent === child || parent.contains(child);
}
