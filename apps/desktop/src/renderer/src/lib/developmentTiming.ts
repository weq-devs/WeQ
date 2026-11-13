export const DEVELOPMENT_TIMING_ENTRY_LIMIT = 64;
export const REACT_COMPONENT_MEASURE_PREFIX = '\u200b';

let uninstall: (() => void) | undefined;

/** React 开发轨道的 props 明细存在原生 UserTiming 缓冲，不让它随运行时间无界保留。 */
export function installDevelopmentTiming(
  target: Pick<Window & typeof globalThis, 'performance' | 'PerformanceObserver'>,
  enabled: boolean,
): () => void {
  uninstall?.();
  const Observer = target.PerformanceObserver;
  if (!enabled || !Observer?.supportedEntryTypes?.includes('measure')) return () => {};
  const names = new Set<string>();
  let retained = 0;
  let disposed = false;
  const clear = () => {
    for (const name of names) target.performance.clearMeasures(name);
    names.clear();
    retained = 0;
  };
  const observer = new Observer((list) => {
    if (disposed) return;
    for (const entry of list.getEntries()) {
      if (!entry.name.startsWith(REACT_COMPONENT_MEASURE_PREFIX)) continue;
      names.add(entry.name);
      retained++;
    }
    // 不读取 detail：读取会把 props 明细再次反序列化到 JS 堆。
    if (retained >= DEVELOPMENT_TIMING_ENTRY_LIMIT) clear();
  });
  try {
    observer.observe({ type: 'measure', buffered: true });
  } catch {
    observer.disconnect();
    return () => {};
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    clear();
    if (uninstall === dispose) uninstall = undefined;
  };
  uninstall = dispose;
  return dispose;
}
