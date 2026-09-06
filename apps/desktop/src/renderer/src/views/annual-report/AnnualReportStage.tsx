import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

const DESIGN_WIDTH = 960;
const DESIGN_HEIGHT = 640;
/** 舞台四周留白比例 —— 报告不贴边，像一页印在纸上的开面。 */
const STAGE_INSET = 0.92;

/**
 * 滚轮翻页的手势判定。
 *
 * 触控板一次「甩」会连发几十个 wheel 事件（惯性尾巴能拖一秒多），固定时长的锁要么
 * 太短（一甩翻三页）要么太长（连续翻页很滞涩）。所以改成**累积 + 静止解锁**：
 *   - 同方向的 deltaY 累加，越过 {@link WHEEL_THRESHOLD} 才翻一页并清零；
 *   - 翻页后进入冷却，冷却里继续累积但不再翻；
 *   - 直到滚轮**停下** {@link WHEEL_IDLE_MS} 毫秒，才认为这一甩结束、允许下一次。
 * 结果是：一甩一页（不管尾巴多长），而缓慢连续滚动能顺畅地一页页翻。
 */
const WHEEL_THRESHOLD = 90;
const WHEEL_IDLE_MS = 220;
/** 翻页动画期间不接受下一次翻页，与 CSS 的 900ms 过渡对齐（留一点余量提前解锁）。 */
const WHEEL_COOLDOWN_MS = 620;

/**
 * 报告舞台：把 960×640 的设计画幅等比缩放到可用空间，页面在画幅内**同位层叠**
 * （不是横向/纵向滑动轨），翻页由各页自己的 transform/opacity/blur 完成景深过渡。
 * 负责滚轮、触摸、键盘三种翻页输入。
 *
 * `guard` 让当前页在翻页发生前截住一次手势（装扮页的「抽屉」用它：滚到底先把
 * 统计刷上来，再滚一次才翻页）。三种输入都经过 `move`，所以只需在这一处问一次。
 */
export function AnnualReportStage({
  index,
  count,
  onIndexChange,
  guard,
  children,
}: {
  index: number;
  count: number;
  onIndexChange: (index: number) => void;
  /** 返回 true = 这一次翻页被当前页消费掉了，舞台不翻。 */
  guard?: (direction: 1 | -1) => boolean;
  children: ReactNode;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{ y: number; moved: boolean } | null>(null);
  /** 滚轮手势状态：累积量、上次事件时刻、以及「这一甩已经翻过了」的冷却截止。 */
  const wheelRef = useRef({ acc: 0, lastAt: 0, until: 0 });
  const [scale, setScale] = useState(1);
  /** 守卫存在 ref 里：`move` 是 useCallback，不能让它随每次 guard 重建而失效。 */
  const guardRef = useRef(guard);
  guardRef.current = guard;

  const clampIndex = useCallback(
    (next: number) => Math.max(0, Math.min(Math.max(0, count - 1), next)),
    [count],
  );
  const move = useCallback(
    (delta: number) => {
      // 守卫先看：它吃掉这次手势时不翻页（但滚轮的冷却仍然照常进入，
      // 免得一甩的惯性尾巴把抽屉刷开后立刻又把页翻走）。
      if (delta !== 0 && guardRef.current?.(delta > 0 ? 1 : -1)) return;
      onIndexChange(clampIndex(index + delta));
    },
    [clampIndex, index, onIndexChange],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const resize = (): void => {
      const rect = host.getBoundingClientRect();
      setScale(
        Math.min(
          (rect.width * STAGE_INSET) / DESIGN_WIDTH,
          (rect.height * STAGE_INSET) / DESIGN_HEIGHT,
        ),
      );
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
    event.preventDefault();
    const now = performance.now();
    const wheel = wheelRef.current;

    // 停够久 → 上一甩结束（含它的惯性尾巴），重新开始累积。
    if (now - wheel.lastAt > WHEEL_IDLE_MS) {
      wheel.acc = 0;
      wheel.until = 0;
    }
    wheel.lastAt = now;

    // 换方向也重新开始 —— 一甩往下、紧接着往上，应当各算一次。
    if (wheel.acc !== 0 && Math.sign(event.deltaY) !== Math.sign(wheel.acc)) wheel.acc = 0;
    wheel.acc += event.deltaY;

    if (now < wheel.until) return; // 冷却中：继续吃掉惯性尾巴，不翻页。
    if (Math.abs(wheel.acc) < WHEEL_THRESHOLD) return;

    move(wheel.acc > 0 ? 1 : -1);
    wheel.acc = 0;
    wheel.until = now + WHEEL_COOLDOWN_MS;
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
        {children}
      </div>
    </div>
  );
}
