import { AsyncLocalStorage } from 'node:async_hooks';
import { getHeapStatistics } from 'node:v8';

const STARTUP_WINDOW_MS = 90_000;
const SAMPLE_ROW_LIMIT = 128;
const SAMPLE_TEXT_LIMIT = 16_384;

type StartupPhase =
  | 'openAccount'
  | 'recentContacts'
  | 'watermarks'
  | 'messageWatchWatermarks'
  | 'unreadSmallTables'
  | 'unreadSnapshotApply'
  | 'contactMembership';

interface PhaseMetrics {
  calls: number;
  elapsedMs: number;
  returnedRows: number;
  sampledRows: number;
  sampledValueBytes: number;
  truncatedTextValues: number;
  peakObservedHeapUsedBytes: number;
  maxObservedHeapGrowthBytes: number;
}

interface Observation {
  phases: Partial<Record<StartupPhase, PhaseMetrics>>;
  changed: boolean;
}

const context = new AsyncLocalStorage<{ observation: Observation; metrics: PhaseMetrics }>();
let current: Observation | undefined;

export function observeDatabaseStartup(enabled: boolean): void {
  if (!enabled) current = undefined;
  else if (!current && performance.now() < STARTUP_WINDOW_MS)
    current = { phases: {}, changed: false };
}

export function databaseStartupSnapshot() {
  const observation = current;
  if (!observation) return undefined;
  if (performance.now() >= STARTUP_WINDOW_MS) current = undefined;
  if (!observation.changed) return undefined;
  observation.changed = false;
  return Object.fromEntries(
    Object.entries(observation.phases).map(([name, phase]) => [name, { ...phase }]),
  );
}

/** Record process-wide heap endpoints. Concurrent work and GC can both affect the deltas. */
export function measureDatabaseStartup<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const observation = current;
  if (!observation || performance.now() >= STARTUP_WINDOW_MS) return run();
  switch (phase) {
    case 'openAccount':
    case 'recentContacts':
    case 'watermarks':
    case 'messageWatchWatermarks':
    case 'unreadSmallTables':
    case 'unreadSnapshotApply':
    case 'contactMembership':
      break;
    default:
      return run();
  }
  observation.phases[phase] ??= {
    calls: 0,
    elapsedMs: 0,
    returnedRows: 0,
    sampledRows: 0,
    sampledValueBytes: 0,
    truncatedTextValues: 0,
    peakObservedHeapUsedBytes: 0,
    maxObservedHeapGrowthBytes: 0,
  };
  const metrics = observation.phases[phase];
  const began = performance.now();
  const before = getHeapStatistics().used_heap_size;
  return context.run({ observation, metrics }, async () => {
    try {
      return await run();
    } finally {
      const after = getHeapStatistics().used_heap_size;
      metrics.calls++;
      metrics.elapsedMs += performance.now() - began;
      metrics.peakObservedHeapUsedBytes = Math.max(
        metrics.peakObservedHeapUsedBytes,
        before,
        after,
      );
      metrics.maxObservedHeapGrowthBytes = Math.max(
        metrics.maxObservedHeapGrowthBytes,
        after - before,
      );
      observation.changed = true;
    }
  });
}

export function recordDatabaseStartupRows(result: unknown[]): void {
  if (!current) return;
  const scope = context.getStore();
  if (!scope || scope.observation !== current || performance.now() >= STARTUP_WINDOW_MS) return;
  const { metrics } = scope;
  metrics.returnedRows += result.length;
  scope.observation.changed = true;
  // Sample existing values in place. Do not copy or serialize the query result for diagnostics.
  const count = Math.min(result.length, SAMPLE_ROW_LIMIT - metrics.sampledRows);
  for (let i = 0; i < count; i++) {
    const row = result[i];
    if (!Array.isArray(row)) continue;
    metrics.sampledRows++;
    for (const value of row) {
      if (typeof value === 'string') {
        if (value.length > SAMPLE_TEXT_LIMIT) metrics.truncatedTextValues++;
        metrics.sampledValueBytes += Buffer.byteLength(value.slice(0, SAMPLE_TEXT_LIMIT));
      } else if (value instanceof Uint8Array) metrics.sampledValueBytes += value.byteLength;
      else if (typeof value === 'number' || typeof value === 'bigint')
        metrics.sampledValueBytes += 8;
    }
  }
}
