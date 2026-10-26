export type MessagePhase =
  | 'observedToRenderer'
  | 'windowQuery'
  | 'entryQuery'
  | 'mapping'
  | 'stateToCommit'
  | 'commitToFrame'
  | 'longTask';
const phases: MessagePhase[] = [
  'observedToRenderer',
  'windowQuery',
  'entryQuery',
  'mapping',
  'stateToCommit',
  'commitToFrame',
  'longTask',
];
const samples = new Map<MessagePhase, { count: number; maxMs: number; values: number[] }>();
const counters = { windowStarted: 0, windowDiscarded: 0, rowRenders: 0 };
let generation = 0;
export function recordMessagePhase(phase: MessagePhase, elapsed: number) {
  if (!Number.isFinite(elapsed) || elapsed < 0) return;
  let entry = samples.get(phase);
  if (!entry) {
    entry = { count: 0, maxMs: 0, values: [] };
    samples.set(phase, entry);
  }
  entry.count++;
  entry.maxMs = Math.max(entry.maxMs, elapsed);
  if (entry.values.length === 256) entry.values.shift();
  entry.values.push(elapsed);
}
export function recordMessageCounter(name: keyof typeof counters) {
  counters[name]++;
}
export async function measureMessagePhase<T>(
  phase: MessagePhase,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const owner = generation;
  try {
    return await run();
  } finally {
    if (owner === generation) recordMessagePhase(phase, performance.now() - started);
  }
}
export function messagePerformanceSnapshot() {
  return {
    schemaVersion: 1,
    implementation: 'virtual-timeline-v1',
    counters: { ...counters },
    phases: Object.fromEntries(
      phases.map((name) => {
        const entry = samples.get(name),
          values = [...(entry?.values ?? [])].sort((a, b) => a - b);
        return [
          name,
          {
            count: entry?.count ?? 0,
            samples: values.length,
            maxMs: entry?.maxMs ?? 0,
            p50Ms: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
            p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
          },
        ];
      }),
    ),
  };
}

/** 主动请求才导出固定字段，不采集消息、账号、URL、路径或原始长任务归属。 */
export function installMessagePerformanceProbe() {
  const owner = ++generation;
  samples.clear();
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
  const collect = () => {
    let output = document.getElementById('weq-message-performance');
    if (!output) {
      output = document.createElement('script');
      output.id = 'weq-message-performance';
      output.setAttribute('type', 'application/json');
      document.body.append(output);
    }
    const timeline = document.querySelector<HTMLElement>(
      '.weq-readonly-chat .weq-virtual-timeline',
    );
    output.textContent = JSON.stringify({
      ...messagePerformanceSnapshot(),
      dom: {
        messageRows: document.querySelectorAll('.weq-readonly-chat [data-message-id]').length,
        virtualRows: document.querySelectorAll('.weq-readonly-chat .weq-virtual-timeline-row')
          .length,
        logicalRows: timeline ? Number(timeline.dataset.totalItems) : null,
      },
    });
  };
  let observer: PerformanceObserver | undefined;
  if (
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('longtask')
  ) {
    observer = new PerformanceObserver((list) => {
      if (owner === generation)
        for (const entry of list.getEntries()) recordMessagePhase('longTask', entry.duration);
    });
    observer.observe({ type: 'longtask' });
  }
  document.addEventListener('weq:message-performance-request', collect);
  return () => {
    if (generation === owner) generation++;
    document.removeEventListener('weq:message-performance-request', collect);
    observer?.disconnect();
    document.getElementById('weq-message-performance')?.remove();
  };
}
