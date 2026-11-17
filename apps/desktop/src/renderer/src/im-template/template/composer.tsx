import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { cn } from './classNames';

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
export type { ComposerMentionTrigger } from './composer.shared';
