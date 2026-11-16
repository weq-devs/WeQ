import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { SlashEmojiFace } from '../lib/slashEmoji';
import { emojiUrl } from '../lib/resourceUrl';
import { useOverlayLayer } from '../lib/overlayStack';
import '../styles/slash-emoji.css';

export function SlashEmojiMenu({
  items,
  id,
  activeIndex,
  editor,
  onSelect,
  onActiveIndexChange,
}: {
  items: readonly SlashEmojiFace[];
  id: string;
  activeIndex: number;
  editor: HTMLElement;
  onSelect: (item: SlashEmojiFace) => void;
  onActiveIndexChange: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const layer = useOverlayLayer(items.length > 0);
  useEffect(() => {
    list.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);
  if (!items.length || !editor.isConnected) return null;
  const rect = editor.getBoundingClientRect();
  const ownerWindow = editor.ownerDocument.defaultView ?? window;
  const viewport = ownerWindow.visualViewport;
  const viewportHeight = viewport?.height ?? ownerWindow.innerHeight;
  const width = Math.min(280, ownerWindow.innerWidth - 16);
  const height = Math.min(296, items.length * 36 + 8, viewportHeight - 16);
  const selection = editor.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const caret =
    range && editor.contains(range.startContainer) ? range.getBoundingClientRect?.() : null;
  const preferredTop = editor.classList.contains('mobile-composer-expanded-editor')
    ? (caret?.height ? caret.bottom : rect.top + 32) + 6
    : rect.top - height - 6;
  const top = Math.max(
    (viewport?.offsetTop ?? 0) + 8,
    Math.min(preferredTop, viewportHeight - height - 8),
  );
  return createPortal(
    <div
      ref={list}
      id={id}
      className="weq-slash-emoji-menu"
      role="listbox"
      aria-label="表情候选"
      style={{
        width,
        maxHeight: height,
        top,
        left: Math.max(8, Math.min(rect.left, ownerWindow.innerWidth - width - 8)),
        zIndex: layer,
      }}
      onPointerDown={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          id={`${id}-${index}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          title={item.desc}
          tabIndex={-1}
          onPointerMove={() => onActiveIndexChange(index)}
          onClick={() => onSelect(item)}
        >
          <img src={emojiUrl(item.id, 'apng', `${item.id}.png`)} alt="" />
          <span>{item.desc.replace(/^\//u, '').replace(/^\[([^\]]+)\]$/u, '$1')}</span>
        </button>
      ))}
    </div>,
    editor.ownerDocument.body,
  );
}
