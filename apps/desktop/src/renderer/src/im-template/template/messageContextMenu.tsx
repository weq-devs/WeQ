import { Copy, Download, Trash2, Edit3, Palette } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { Message } from './types';
import { cn } from './classNames';

export type MessageContextMenuState = {
  message: Message;
  x: number;
  y: number;
  downloadUrl?: string;
  variant?: 'desktop' | 'mobile';
  /**
   * Click point offset within the anchored message row at open time. Used to
   * keep the desktop menu glued to its message while the list scrolls.
   */
  anchorOffsetX?: number;
  anchorOffsetY?: number;
};

export function MessageContextMenu({
  state,
  onCopy,
  onDownloadImage,
  onDelete,
  onEditRaw,
  onViewDecoration,
}: {
  state: MessageContextMenuState;
  onCopy: (message: Message) => void | Promise<void>;
  onDownloadImage?: (url: string, message: Message) => void;
  /** QQ-style delete: message stays in the chat under a "deleted" overlay, restorable. */
  onDelete: (message: Message) => void;
  onEditRaw?: (message: Message) => void;
  onViewDecoration?: (message: Message) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const decoration = (
    state.message as { decoration?: { fontId?: number; bubbleId?: number; widgetId?: number } }
  ).decoration;
  const hasDecoration =
    decoration && (decoration.fontId || decoration.bubbleId || decoration.widgetId);

  // 菜单是 fixed 定位，但打开时和滚动跟随只按估算尺寸钳制；这里用渲染后的
  // 实际尺寸把菜单拉回窗口内，避免靠近窗口边缘（尤其底部）时被截断。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 8;
    if (state.variant === 'mobile') {
      const halfWidth = rect.width / 2;
      el.style.left = `${Math.min(
        Math.max(state.x, halfWidth + margin),
        Math.max(halfWidth + margin, window.innerWidth - halfWidth - margin),
      )}px`;
    } else {
      el.style.left = `${Math.min(
        Math.max(state.x, margin),
        Math.max(margin, window.innerWidth - rect.width - margin),
      )}px`;
    }
    el.style.top = `${Math.min(
      Math.max(state.y, margin),
      Math.max(margin, window.innerHeight - rect.height - margin),
    )}px`;
  }, [state.x, state.y, state.variant]);

  return (
    <div
      ref={menuRef}
      className={cn(
        'message-context-menu',
        state.variant === 'mobile' && 'message-context-menu-mobile',
        state.downloadUrl && 'message-context-menu-has-download',
      )}
      style={
        state.variant === 'mobile'
          ? { left: state.x, top: state.y, transform: 'translateX(-50%)' }
          : { left: state.x, top: state.y }
      }
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <button type="button" onClick={() => void onCopy(state.message)}>
        <Copy size={17} />
        <span>复制</span>
      </button>
      {onEditRaw ? (
        <button type="button" onClick={() => onEditRaw(state.message)}>
          <Edit3 size={17} />
          <span>修改</span>
        </button>
      ) : null}
      {hasDecoration && onViewDecoration ? (
        <button type="button" onClick={() => onViewDecoration(state.message)}>
          <Palette size={17} />
          <span>装扮</span>
        </button>
      ) : null}
      {state.downloadUrl && onDownloadImage ? (
        <button
          type="button"
          onClick={() => onDownloadImage(state.downloadUrl ?? '', state.message)}
        >
          <Download size={17} />
          <span>下载</span>
        </button>
      ) : null}
      <button type="button" onClick={() => onDelete(state.message)}>
        <Trash2 size={17} />
        <span>删除</span>
      </button>
    </div>
  );
}
