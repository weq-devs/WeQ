import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTabActive } from '../../components/RetainedTabs.shared';
import { topSurface } from '../../lib/surfaceEscape';
import { reportCanTurn, reportGestureTarget, reportSwipeDirection } from '../../lib/reportSwipe';
import '../../styles/annual-report-reading.css';

const DESIGN_WIDTH = 960;
const DESIGN_HEIGHT = 640;
/** 舞台四周留白比例 —— 报告不贴边，像一页印在纸上的开面。 */
const STAGE_INSET = 0.92;

/**
 * 滚轮翻页的手势判定 —— **一次滚动最多翻一页**。
 *
 * 触控板一次「甩」会连发几十个 wheel 事件（惯性尾巴能拖一秒多），按固定时长的
 * 锁去卡都稳不住：锁短了（600ms）尾巴还没衰减完，第二页、第三页就跟着翻走了；
 * 锁长了则「滚一下、翻一页」变得很滞涩。所以判定不看时间长短，而看**一次手势的
 * 边界**：
 *   - 同方向的 deltaY 累加，越过 {@link WHEEL_THRESHOLD} 才翻一页、清零累积；
 *   - 翻页后，本次手势的惯性尾巴不再翻页；在阅读模式内开始滚动也会保持这一手势用途；
 *   - 直到滚轮**停下** {@link WHEEL_IDLE_MS} 毫秒，才认为手势结束。
 * 于是「一甩一页」是结构上成立的，而「滚一下、停一下」仍是一页页顺畅地翻。
 */
const WHEEL_THRESHOLD = 90;
const WHEEL_IDLE_MS = 220;

function reportHasOverlay(host: HTMLElement): boolean {
  const top = topSurface(host.ownerDocument);
  return Boolean(top && !top.contains(host));
}

/**
 * 宽屏演示把 960×640 画幅缩放到可用空间；窄/短内容区采用原字号滚动阅读。
 * 页面在画幅内**同位层叠**
 * （不是横向/纵向滑动轨），翻页由各页自己的 transform/opacity/blur 完成景深过渡。
 * 负责滚轮、触摸、键盘三种翻页输入。
 *
 * `guard` 让当前页在翻页发生前截住一次手势（「我的主场」用它转轮盘：转到边界
 * 才放行翻页）。三种输入都经过 `move`，所以只需问一次。
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
  const tabActive = useTabActive();
  const hostRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{
    x: number;
    y: number;
    pointerId: number;
    captured: boolean;
  } | null>(null);
  /** 滚轮手势状态：累积量、上次事件时刻与当前手势用途。 */
  const wheelRef = useRef({ acc: 0, lastAt: 0, mode: null as 'scroll' | 'turn' | null });
  const [scale, setScale] = useState(1);
  const [reading, setReading] = useState(false);
  /** 守卫存在 ref 里：`move` 是 useCallback，不能让它随每次 guard 重建而失效。 */
  const guardRef = useRef(guard);
  guardRef.current = guard;

  const clampIndex = useCallback(
    (next: number) => Math.max(0, Math.min(Math.max(0, count - 1), next)),
    [count],
  );
  const move = useCallback(
    (delta: number) => {
      // 当前页消费翻页动作后，滚轮的手势锁仍保留到惯性结束。
      if (delta !== 0 && guardRef.current?.(delta > 0 ? 1 : -1)) return;
      onIndexChange(clampIndex(index + delta));
    },
    [clampIndex, index, onIndexChange],
  );

  useEffect(() => {
    if (!tabActive) return;
    const host = hostRef.current;
    if (!host) return undefined;
    const resize = (): void => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setReading(rect.width < 720 || rect.height < 400);
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
  }, [tabActive]);

  /**
   * 原生 `wheel` 监听设为 `passive: false` 才能合法 `preventDefault`。React 的
   * `onWheel` 委托到 passive listener，调用 preventDefault 只会让控制台刷警告，
   * 也拦不住页面滚动。滚轮翻页本来就是我们自己判定的手势，所以直接接管宿主。
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !tabActive) return undefined;
    const onWheel = (event: WheelEvent): void => {
      const { deltaMode, deltaX, deltaY } = event;
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.shiftKey ||
        Math.abs(deltaY) <= Math.abs(deltaX) ||
        reportHasOverlay(host)
      )
        return;
      if (!reportGestureTarget(event.target)) return;
      const now = performance.now();
      const wheel = wheelRef.current;

      // 停够久 → 上一甩（连同它的惯性尾巴）结束了，解锁下一次翻页。
      if (now - wheel.lastAt > WHEEL_IDLE_MS) {
        wheel.acc = 0;
        wheel.mode = null;
      }
      wheel.lastAt = now;

      if (wheel.mode === 'scroll') return;
      if (
        reading &&
        !wheel.mode &&
        !wheel.acc &&
        !reportCanTurn(event.target, host, deltaY > 0 ? 1 : -1)
      ) {
        wheel.mode = 'scroll';
        return;
      }
      event.preventDefault();

      // 这一甩已经翻过了：惯性尾巴照单全吃，不再翻第二页。
      if (wheel.mode === 'turn') return;

      // 尚未达到阈值时，反向滚动重置累积量。
      if (wheel.acc !== 0 && Math.sign(deltaY) !== Math.sign(wheel.acc)) wheel.acc = 0;
      wheel.acc +=
        deltaY *
        (deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 40
          : deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? host.clientHeight
            : 1);

      if (Math.abs(wheel.acc) < WHEEL_THRESHOLD) return;

      // 锁定这一手势，等惯性结束再允许继续翻页。
      const direction = wheel.acc > 0 ? 1 : -1;
      wheel.acc = 0;
      wheel.mode = 'turn';
      move(direction);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [move, tabActive, reading]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !tabActive) return;
    let gesture: { id: number; x: number; y: number; up: boolean; down: boolean } | null = null;
    const start = (event: TouchEvent) => {
      gesture = null;
      if (
        event.touches.length !== 1 ||
        reportHasOverlay(host) ||
        !reportGestureTarget(event.target) ||
        !window.getSelection()?.isCollapsed
      )
        return;
      const touch = event.touches[0]!;
      gesture = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        up: reportCanTurn(event.target, host, 1),
        down: reportCanTurn(event.target, host, -1),
      };
    };
    const drag = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) {
        gesture = null;
        return;
      }
      const touch = event.touches[0]!;
      const dx = touch.clientX - gesture.x,
        dy = touch.clientY - gesture.y;
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        gesture = null;
        return;
      }
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx) * 1.5) {
        if (!(dy < 0 ? gesture.up : gesture.down)) {
          gesture = null;
          return;
        }
        if (!event.cancelable) {
          gesture = null;
          return;
        }
        event.preventDefault();
      }
    };
    const end = (event: TouchEvent) => {
      const current = gesture;
      gesture = null;
      if (
        !current ||
        event.touches.length ||
        reportHasOverlay(host) ||
        !window.getSelection()?.isCollapsed
      )
        return;
      const touch = [...event.changedTouches].find((item) => item.identifier === current.id);
      if (!touch) return;
      const direction = reportSwipeDirection(touch.clientX - current.x, touch.clientY - current.y);
      if (direction && (direction > 0 ? current.up : current.down)) move(direction);
    };
    const cancel = () => {
      gesture = null;
    };
    host.addEventListener('touchstart', start, { passive: true });
    host.addEventListener('touchmove', drag, { passive: false });
    host.addEventListener('touchend', end);
    host.addEventListener('touchcancel', cancel);
    return () => {
      host.removeEventListener('touchstart', start);
      host.removeEventListener('touchmove', drag);
      host.removeEventListener('touchend', end);
      host.removeEventListener('touchcancel', cancel);
    };
  }, [move, tabActive]);

  useEffect(() => {
    if (!tabActive) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (
        event.defaultPrevented ||
        (hostRef.current && reportHasOverlay(hostRef.current)) ||
        (event.target instanceof Element &&
          event.target.closest('input, textarea, select, button, a, [contenteditable="true"]'))
      )
        return;
      const direction = ['ArrowDown', 'PageDown', ' '].includes(event.key)
        ? 1
        : ['ArrowUp', 'PageUp'].includes(event.key)
          ? -1
          : 0;
      const page = hostRef.current?.querySelector<HTMLElement>('.weq-report-slide.is-active');
      if (
        reading &&
        direction &&
        page &&
        hostRef.current &&
        !reportCanTurn(page, hostRef.current, direction)
      ) {
        event.preventDefault();
        page.scrollTop +=
          direction * (event.key.startsWith('Arrow') ? 40 : page.clientHeight * 0.8);
        return;
      }
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
  }, [count, move, onIndexChange, tabActive, reading]);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (
      reading ||
      event.pointerType !== 'mouse' ||
      event.button !== 0 ||
      !reportGestureTarget(event.target)
    )
      return;
    // 刻意不在 pointerdown 就 setPointerCapture：捕获会把后续 pointerup 重定向到
    // 舞台宿主，叠在它上面的 click 事件就到不了页面里的按钮 —— 年份刻度、CTA、
    // 重试全都「点了没反应、控制台无报错」。捕获推迟到手势真正成立的那一刻。
    gestureRef.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      captured: false,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (reading) {
      gestureRef.current = null;
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = Math.abs(event.clientX - gesture.x);
    const dy = Math.abs(event.clientY - gesture.y);
    if (dy < 24 || dy < dx * 1.5 || window.getSelection()?.isCollapsed === false) return;
    if (!gesture.captured) {
      // 拖拽跨过阈值、确认是翻页手势，才把这一指的剩余事件接管给舞台。
      // 捕获可能失败：那根手指可能已被系统手势/别的元素截走（报 NotFoundError），
      // 也可能 capture 已被别人持有（InvalidStateError）。两种都只当「没捕到」
      // 处理，翻页判定靠 pointerup 的位移照样成立，不能让异常炸掉渲染进程。
      try {
        event.currentTarget.setPointerCapture(gesture.pointerId);
        gesture.captured = true;
      } catch {
        gesture.captured = false;
      }
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (
      reading ||
      !gesture ||
      gesture.pointerId !== event.pointerId ||
      window.getSelection()?.isCollapsed === false
    )
      return;
    const dx = Math.abs(event.clientX - gesture.x);
    const dy = event.clientY - gesture.y;
    if (Math.abs(dy) >= 24 && Math.abs(dy) >= dx * 1.5) move(dy < 0 ? 1 : -1);
  }

  return (
    <div
      ref={hostRef}
      className="weq-report-stage-host"
      data-layout={reading ? 'reading' : 'presentation'}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        gestureRef.current = null;
      }}
      role="region"
      aria-label="年度报告页面"
    >
      <div
        className="weq-report-stage"
        style={
          reading
            ? undefined
            : {
                width: DESIGN_WIDTH,
                height: DESIGN_HEIGHT,
                transform: `translate(-50%, -50%) scale(${scale})`,
              }
        }
      >
        {children}
      </div>
    </div>
  );
}
