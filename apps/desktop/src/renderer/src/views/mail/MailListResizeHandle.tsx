import { useRef, type PointerEvent } from 'react';

export function MailListResizeHandle({
  width,
  max,
  onChange,
  onCommit,
}: {
  width: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; width: number; next: number } | null>(null);
  const clamp = (value: number) => Math.round(Math.max(280, Math.min(max, value)));
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    drag.current = null;
    const value = cancel ? active.width : active.next;
    onChange(value);
    if (!cancel) onCommit(value);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      className="weq-mail-resize"
      role="separator"
      tabIndex={0}
      aria-label="调整邮件列表宽度"
      aria-orientation="vertical"
      aria-valuemin={280}
      aria-valuemax={max}
      aria-valuenow={width}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        drag.current = { id: event.pointerId, x: event.clientX, width, next: width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        active.next = clamp(active.width + event.clientX - active.x);
        onChange(active.next);
      }}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      onDoubleClick={() => {
        const value = clamp(360);
        onChange(value);
        onCommit(value);
      }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const value = clamp(
          event.key === 'Home'
            ? 280
            : event.key === 'End'
              ? max
              : width + (event.key === 'ArrowLeft' ? -16 : 16),
        );
        onChange(value);
        onCommit(value);
      }}
    />
  );
}
