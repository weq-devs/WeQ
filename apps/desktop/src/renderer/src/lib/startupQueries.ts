import { scheduleBackgroundLoad } from './backgroundLoad';

export type StartupQueryStage = 0 | 1 | 2 | 3 | 4 | 5;

export function nextStartupQueryStage(
  stage: StartupQueryStage,
  firstPageReady: boolean,
  previousBatchSettled: boolean,
): StartupQueryStage | null {
  if (!firstPageReady || stage === 5 || (stage > 0 && !previousBatchSettled)) return null;
  return (stage + 1) as StartupQueryStage;
}

/** 至少让首屏绘制一帧；忙碌后重新让出绘制机会，再在空闲时放行下一批。 */
export function scheduleStartupQueryBatch(run: () => void, canRun: () => boolean): () => void {
  let disposed = false;
  let frame: number | undefined;
  let cancelPending: (() => void) | undefined;
  const afterPaint = () => {
    if (disposed) return;
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        if (disposed) return;
        cancelPending = scheduleBackgroundLoad(() => {
          if (disposed) return;
          if (document.visibilityState === 'hidden' || !canRun()) {
            cancelPending = scheduleBackgroundLoad(afterPaint, 100);
            return;
          }
          const waitingForPaint =
            window.top === window &&
            window.PerformanceObserver?.supportedEntryTypes?.includes('paint') &&
            !window.performance.getEntriesByName('first-contentful-paint').length;
          if (waitingForPaint) {
            cancelPending = scheduleBackgroundLoad(afterPaint, 0);
            return;
          }
          disposed = true;
          run();
        }, 0);
      });
    });
  };
  afterPaint();
  return () => {
    disposed = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    cancelPending?.();
  };
}
