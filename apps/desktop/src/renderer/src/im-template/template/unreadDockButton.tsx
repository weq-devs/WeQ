import { Bookmark, ChevronsUp, Sparkles } from 'lucide-react';
import { type PointerEvent, useRef } from 'react';
import type { UnreadDockStop } from './types';
import { dockStopLabel, highlightLabel } from './unreadDock';

export type ChatJumpStop = UnreadDockStop | { kind: 'reading' };

const DRAG_SLOP = 10;
const DISMISS_DISTANCE = 60;
const LONG_PRESS_MS = 450;

export function UnreadDockJumpButton({
  stop,
  importantRemaining,
  jumping,
  onJump,
  onOpenImportant,
  onSwipeDismiss,
}: {
  stop: ChatJumpStop;
  importantRemaining: number;
  jumping: boolean;
  onJump: () => void;
  onOpenImportant?: () => void;
  onSwipeDismiss?: () => void;
}) {
  const press = useRef<{
    id: number;
    x: number;
    y: number;
    at: number;
    direction?: 'right' | 'other';
  }>(undefined);
  const suppressClick = useRef(false);
  const important = stop.kind !== 'unread' && stop.kind !== 'reading';
  const label = stop.kind === 'reading' ? '跳到上次阅读位置' : dockStopLabel(stop);

  function finish(event: PointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const start = press.current;
    if (!start || start.id !== event.pointerId) return;
    press.current = undefined;
    event.currentTarget.parentElement?.style.removeProperty('--weq-dock-drag');
    if (cancelled) {
      suppressClick.current = true;
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (start.direction || Math.hypot(dx, dy) >= DRAG_SLOP) {
      suppressClick.current = true;
      if (start.direction !== 'other' && dx >= DISMISS_DISTANCE && dx > Math.abs(dy) * 1.5)
        onSwipeDismiss?.();
    } else if (onOpenImportant && performance.now() - start.at >= LONG_PRESS_MS) {
      suppressClick.current = true;
      onOpenImportant();
    }
  }

  return (
    <button
      type="button"
      className={onSwipeDismiss ? 'weq-dock-touch' : undefined}
      title={important ? `下一条：${label}` : label}
      disabled={jumping}
      onPointerDown={(event) => {
        if (!event.isPrimary) return;
        suppressClick.current = false;
        if (event.pointerType !== 'touch' || (!onOpenImportant && !onSwipeDismiss)) return;
        press.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          at: performance.now(),
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = press.current;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!start.direction && Math.hypot(dx, dy) >= DRAG_SLOP)
          start.direction = dx > Math.abs(dy) * 1.5 ? 'right' : 'other';
        if (onSwipeDismiss && start.direction === 'right')
          event.currentTarget.parentElement?.style.setProperty(
            '--weq-dock-drag',
            `${Math.min(96, Math.max(0, dx))}px`,
          );
      }}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      onContextMenu={(event) => {
        if (press.current) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') suppressClick.current = false;
      }}
      onClick={() => {
        const suppressed = suppressClick.current;
        suppressClick.current = false;
        if (!suppressed) onJump();
      }}
    >
      {stop.kind === 'reading' ? (
        <Bookmark size={13} aria-hidden />
      ) : stop.kind === 'unread' ? (
        <ChevronsUp size={13} strokeWidth={2.4} aria-hidden />
      ) : (
        <Sparkles size={13} strokeWidth={2.4} aria-hidden />
      )}
      <span className="unread-dock-label">
        {stop.kind === 'unread' || stop.kind === 'reading' ? label : highlightLabel(stop.kind)}
      </span>
      {important ? (
        <span className="unread-dock-count" aria-label={`剩余 ${importantRemaining} 条重要消息`}>
          {importantRemaining}
        </span>
      ) : null}
    </button>
  );
}
