let enabled = false;
const noop = (_failed?: boolean) => {};
const stats = { active: 0, completed: 0, failed: 0, durationMs: 0, maxMs: 0 };
export function enableRequestMetrics(value: boolean) {
  enabled = value;
}
export function beginRequestMetric(path: string) {
  if (!enabled || path.startsWith('performanceMonitor.')) return noop;
  const started = performance.now();
  stats.active++;
  let finished = false;
  return (failed = false) => {
    if (finished) return;
    finished = true;
    stats.active--;
    stats.completed++;
    if (failed) stats.failed++;
    const elapsed = performance.now() - started;
    stats.durationMs += elapsed;
    stats.maxMs = Math.max(stats.maxMs, elapsed);
  };
}
export function requestMetrics() {
  return { ...stats };
}
