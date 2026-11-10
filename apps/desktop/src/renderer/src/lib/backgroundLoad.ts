/** 首屏查询完成后让出渲染机会；每次补页重新让出，不连续抢占连接。 */
export function scheduleBackgroundLoad(run: () => void, delay = 300): () => void {
  let idle: number | undefined;
  const timer = window.setTimeout(() => {
    if (window.requestIdleCallback) idle = window.requestIdleCallback(run, { timeout: 2000 });
    else run();
  }, delay);
  return () => {
    window.clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}
