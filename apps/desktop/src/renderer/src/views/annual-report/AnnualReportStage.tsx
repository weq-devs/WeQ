import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

const DESIGN_WIDTH = 960;
const DESIGN_HEIGHT = 640;

export function AnnualReportStage({
  index,
  count,
  onIndexChange,
  children,
}: {
  index: number;
  count: number;
  onIndexChange: (index: number) => void;
  children: ReactNode;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{ y: number; moved: boolean } | null>(null);
  const wheelLockRef = useRef(false);
  const [scale, setScale] = useState(1);

  const clampIndex = useCallback(
    (next: number) => Math.max(0, Math.min(Math.max(0, count - 1), next)),
    [count],
  );
  const move = useCallback(
    (delta: number) => {
      onIndexChange(clampIndex(index + delta));
    },
    [clampIndex, index, onIndexChange],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const resize = (): void => {
      const rect = host.getBoundingClientRect();
      setScale(Math.min(rect.width / DESIGN_WIDTH, rect.height / DESIGN_HEIGHT));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        onIndexChange(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        onIndexChange(Math.max(0, count - 1));
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [count, move, onIndexChange]);

  function onWheel(event: React.WheelEvent<HTMLDivElement>): void {
    if (wheelLockRef.current || Math.abs(event.deltaY) < 8) return;
    event.preventDefault();
    wheelLockRef.current = true;
    move(event.deltaY > 0 ? 1 : -1);
    window.setTimeout(() => {
      wheelLockRef.current = false;
    }, 420);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    gestureRef.current = { y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = gestureRef.current;
    if (!gesture || Math.abs(event.clientY - gesture.y) < 24) return;
    gesture.moved = true;
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture?.moved) return;
    move(event.clientY < gesture.y ? 1 : -1);
  }

  return (
    <div
      ref={hostRef}
      className="weq-report-stage-host"
      tabIndex={0}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="region"
      aria-label="年度报告页面"
    >
      <div
        className="weq-report-stage"
        style={{
          width: DESIGN_WIDTH,
          height: DESIGN_HEIGHT,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        <div
          className="weq-report-deck"
          style={{ transform: `translateY(-${index * DESIGN_HEIGHT}px)` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
