import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import {
  beginQueryTrace,
  databaseQueryDiagnostics,
  withDatabaseWorkPhase,
  type QuerySource,
  type QueryTrace,
} from './query_diagnostics';

export type DatabasePriority = 'interactive' | 'background';
export const SLOW_DATABASE_OPERATION_MS = 500;
export interface SlowDatabaseOperation {
  priority: DatabasePriority;
  jsQueueWaitMs: number;
  nativePromiseAwaitMs: number;
  outcome: 'ok' | 'failed' | 'cancelled';
  fingerprint?: string;
  caller?: string;
}
const slowObservers = new Map<(sample: SlowDatabaseOperation) => void, number>();
let observationThreshold = Number.POSITIVE_INFINITY;
export function observeSlowDatabaseOperations(
  observer: (sample: SlowDatabaseOperation) => void,
  thresholdMs = SLOW_DATABASE_OPERATION_MS,
): () => void {
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) throw new Error('数据库采样阈值无效');
  slowObservers.set(observer, thresholdMs);
  observationThreshold = Math.min(...slowObservers.values());
  return () => {
    slowObservers.delete(observer);
    observationThreshold = Math.min(...slowObservers.values());
  };
}
const priority = new AsyncLocalStorage<{ priority: DatabasePriority; signal?: AbortSignal }>();
const readBudget = new AsyncLocalStorage<{
  milliseconds: number;
  onRead?: (milliseconds: number) => void;
  onWait?: () => void;
  onState?: (state: 'idle' | 'queued' | 'reading' | undefined) => void;
}>();
export function withDatabaseReadBudget<T>(
  budgetMs: number,
  run: () => T,
  onRead?: (milliseconds: number) => void,
  onWait?: () => void,
  onState?: (state: 'idle' | 'queued' | 'reading' | undefined) => void,
): T {
  return readBudget.run({ milliseconds: budgetMs, onRead, onWait, onState }, run);
}
export function databaseReadBudget() {
  return readBudget.getStore();
}
const promotedSignals = new WeakSet<AbortSignal>();
export function databaseRequestSignal(): AbortSignal | undefined {
  return priority.getStore()?.signal;
}
export function withDatabasePriority<T>(
  value: DatabasePriority,
  run: () => T,
  signal?: AbortSignal,
): T {
  return priority.run(
    {
      get priority() {
        return signal && promotedSignals.has(signal) ? 'interactive' : value;
      },
      signal,
    },
    run,
  );
}

/** 为后台生命周期补充取消信号，不覆盖调用方已有的优先级或取消条件。 */
export function withDatabaseSignal<T>(signal: AbortSignal, run: () => T): T {
  const inherited = priority.getStore();
  const parentSignal = inherited?.signal;
  return priority.run(
    {
      get priority() {
        return inherited?.priority ?? 'interactive';
      },
      signal:
        parentSignal && parentSignal !== signal ? AbortSignal.any([parentSignal, signal]) : signal,
    },
    run,
  );
}

interface Series {
  count: number;
  totalMs: number;
  maxMs: number;
  values: number[];
}
const series = (): Series => ({ count: 0, totalMs: 0, maxMs: 0, values: [] });
function record(data: Series, value: number) {
  data.count++;
  data.totalMs += value;
  data.maxMs = Math.max(data.maxMs, value);
  if (data.values.length === 256) data.values.shift();
  data.values.push(value);
}
function summary(data: Series) {
  const values = [...data.values].sort((a, b) => a - b);
  return {
    count: data.count,
    samples: values.length,
    totalMs: data.totalMs,
    maxMs: data.maxMs,
    p50Ms: values.length ? values[Math.ceil(values.length * 0.5) - 1]! : null,
    p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1]! : null,
  };
}
interface Job {
  trace?: QueryTrace;
  at: number;
  priority: DatabasePriority;
  signal?: AbortSignal;
  start(): Promise<void>;
  abort(): void;
}
interface Queue {
  path: string;
  running: boolean;
  interactiveBurst: number;
  interactive: Job[];
  background: Job[];
  current?: Job;
}
const queues = new Map<string, Queue>();

/** 复用已开始的预取；只提升未执行 SQL，不抢占 native 当前工作。 */
export function promoteDatabaseSignal(signal: AbortSignal): void {
  if (signal.aborted) return;
  promotedSignals.add(signal);
  for (const queue of queues.values()) {
    if (queue.current?.signal === signal) {
      queue.current.priority = 'interactive';
      if (queue.current.trace) queue.current.trace.priority = 'interactive';
      metric(queue.path).lastInteractiveAt = performance.now();
    }
    const jobs = queue.background.filter((job) => job.signal === signal);
    queue.background = queue.background.filter((job) => job.signal !== signal);
    for (const job of jobs) {
      job.priority = 'interactive';
      if (job.trace) job.trace.priority = 'interactive';
      queue.interactive.push(job);
    }
  }
}
const bindingAliases = new WeakMap<object, object>();
const bindingIds = new WeakMap<object, number>();
const defaultBinding = {};
let nextBindingId = 1;
export function aliasDatabaseBinding<T extends object>(binding: T, underlying: object): T {
  bindingAliases.set(binding, bindingAliases.get(underlying) ?? underlying);
  return binding;
}
function bindingId(binding: object) {
  const root = bindingAliases.get(binding) ?? binding;
  let id = bindingIds.get(root);
  if (id === undefined) {
    id = nextBindingId++;
    bindingIds.set(root, id);
  }
  return id;
}
export type MessageWorkPhase =
  | 'watermarks'
  | 'unreadPersistence'
  | 'replyCache'
  | 'messagePage'
  | 'roamingCache';
const metrics = new Map<
  string,
  {
    wait: Series;
    nativeAwait: Series;
    phases: Partial<Record<MessageWorkPhase, Series>>;
    failed: number;
    rows: number;
    peakQueued: number;
    indexed: number;
    fallback: number;
    lastInteractiveAt: number;
  }
>();
function metric(key: string) {
  let value = metrics.get(key);
  if (!value) {
    value = {
      wait: series(),
      nativeAwait: series(),
      phases: {},
      failed: 0,
      rows: 0,
      peakQueued: 0,
      indexed: 0,
      fallback: 0,
      lastInteractiveAt: performance.now(),
    };
    metrics.set(key, value);
    while (metrics.size > 64) metrics.delete(metrics.keys().next().value!);
  }
  return value;
}

export async function measureMessageWork<T>(
  dbPath: string | undefined,
  phase: MessageWorkPhase,
  run: () => Promise<T>,
): Promise<T> {
  const began = performance.now();
  try {
    return await withDatabaseWorkPhase(phase, run);
  } finally {
    recordMessageWork(dbPath, phase, performance.now() - began);
  }
}

/** JS 侧非抢占调度；不把 native Promise 总耗时冒称原生执行耗时。 */
export function scheduleDatabase<T>(
  dbPath: string,
  run: () => Promise<T>,
  binding: object = defaultBinding,
  source?: QuerySource,
): Promise<T> {
  const path = resolve(dbPath),
    key = `${bindingId(binding)}:${path}`,
    context = priority.getStore();
  const kind = context?.priority ?? 'interactive',
    signal = context?.signal;
  if (signal?.aborted) return Promise.reject(new DOMException('数据库读取已取消', 'AbortError'));
  let queue = queues.get(key);
  if (!queue) {
    queue = { path, running: false, interactiveBurst: 0, interactive: [], background: [] };
    queues.set(key, queue);
  }
  const state = queue,
    data = metric(path);
  if (state.interactive.length + state.background.length >= 4096)
    return Promise.reject(new Error('数据库查询队列已满，请稍后重试'));
  // 排空队列的循环可能属于另一请求；诊断回调仍使用本次入队时的异步上下文。
  const notifySlow = slowObservers.size
    ? AsyncLocalStorage.bind((sample: SlowDatabaseOperation) => {
        for (const [observer, threshold] of slowObservers) {
          if (sample.jsQueueWaitMs <= threshold && sample.nativePromiseAwaitMs <= threshold)
            continue;
          try {
            observer(sample);
          } catch {
            /* 诊断不能干扰队列。 */
          }
        }
      })
    : undefined;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const pending = state[job.priority].indexOf(job);
      if (pending < 0) return;
      state[job.priority].splice(pending, 1);
      if (job.trace) {
        job.trace.endedAtMs = performance.now();
        job.trace.outcome = 'cancelled';
      }
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('数据库读取已取消', 'AbortError'));
    };
    const job: Job = {
      trace: beginQueryTrace(path, kind, source, state.current?.trace),
      at: performance.now(),
      priority: kind,
      signal,
      abort,
      async start() {
        signal?.removeEventListener('abort', abort);
        const jsQueueWaitMs = performance.now() - job.at;
        record(data.wait, jsQueueWaitMs);
        const began = performance.now();
        let outcome: SlowDatabaseOperation['outcome'] = 'ok';
        if (job.trace) {
          job.trace.priority = job.priority;
          job.trace.startedAtMs = began;
          job.trace.outcome = 'running';
        }
        try {
          const result = await run();
          if (job.trace) {
            job.trace.outcome = 'ok';
            if (Array.isArray(result)) job.trace.rows = result.length;
          }
          if (Array.isArray(result)) data.rows += result.length;
          resolve(result);
        } catch (error) {
          outcome = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
          if (job.trace)
            job.trace.outcome =
              error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
          data.failed++;
          reject(error);
        } finally {
          if (job.trace) job.trace.endedAtMs = performance.now();
          const nativePromiseAwaitMs = performance.now() - began;
          record(data.nativeAwait, nativePromiseAwaitMs);
          if (jsQueueWaitMs > observationThreshold || nativePromiseAwaitMs > observationThreshold) {
            notifySlow?.({
              priority: job.priority,
              jsQueueWaitMs,
              nativePromiseAwaitMs,
              outcome,
              ...(job.trace?.source ?? source ?? {}),
            });
          }
          if (job.priority === 'interactive') data.lastInteractiveAt = performance.now();
        }
      },
    };
    state[kind].push(job);
    signal?.addEventListener('abort', abort, { once: true });
    data.peakQueued = Math.max(data.peakQueued, state.interactive.length + state.background.length);
    if (!state.running) {
      state.running = true;
      void (async () => {
        try {
          while (state.interactive.length || state.background.length) {
            const foreground =
              state.interactive.length > 0 &&
              (state.interactiveBurst < 8 || !state.background.length);
            const next = (foreground ? state.interactive : state.background).shift()!;
            state.interactiveBurst = foreground ? state.interactiveBurst + 1 : 0;
            state.current = next;
            try {
              await next.start();
            } finally {
              state.current = undefined;
            }
            // 批间让出，使 IPC 新请求有机会在下一条后台 SQL 前入队。
            if (state.interactive.length || state.background.length)
              await new Promise<void>((done) => setImmediate(done));
          }
        } finally {
          state.running = false;
          if (queues.get(key) === state) queues.delete(key);
        }
      })();
    }
  });
}

export function recordMessagePartition(dbPath: string | undefined, indexed: boolean): void {
  if (!dbPath) return;
  const data = metric(resolve(dbPath));
  if (indexed) data.indexed++;
  else data.fallback++;
}

export function recordMessageWork(
  dbPath: string | undefined,
  phase: MessageWorkPhase,
  elapsedMs: number,
): void {
  if (!dbPath || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  const phases = metric(resolve(dbPath)).phases;
  phases[phase] ??= series();
  record(phases[phase], elapsedMs);
}

export async function waitForDatabaseQuiet(
  dbPath: string,
  current: () => boolean,
  quietMs = 5000,
  onWait?: () => void,
): Promise<boolean> {
  const key = resolve(dbPath);
  let notified = false;
  while (current()) {
    const active = [...queues.values()].some(
      (queue) =>
        queue.path === key &&
        (queue.running || queue.interactive.length || queue.background.length),
    );
    const data = metric(key);
    if (!active && performance.now() - data.lastInteractiveAt >= quietMs) return true;
    if (!notified) {
      onWait?.();
      notified = true;
    }
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  return false;
}

/** 固定字段、无 SQL／参数／路径；仅供脱敏诊断，不暴露账号标识。 */
export function databasePerformance(dbPath: string) {
  const key = resolve(dbPath),
    data = metric(key),
    active = [...queues.values()].filter((queue) => queue.path === key);
  const waiting = active.flatMap((queue) => [...queue.interactive, ...queue.background]);
  return {
    schemaVersion: 1,
    jsQueueWait: summary(data.wait),
    nativePromiseAwait: summary(data.nativeAwait),
    nativeExecutionMs: null,
    nativeQueueMs: null,
    queued: waiting.length,
    inFlight: active.filter((queue) => queue.running).length,
    oldestWaitMs: waiting.length
      ? Math.max(0, performance.now() - Math.min(...waiting.map((job) => job.at)))
      : 0,
    peakQueued: data.peakQueued,
    failed: data.failed,
    returnedRows: data.rows,
    phases: Object.fromEntries(
      Object.entries(data.phases).map(([name, values]) => [name, summary(values)]),
    ),
    partition: { indexed: data.indexed, uidFallback: data.fallback },
    diagnostics: databaseQueryDiagnostics(
      key,
      active.flatMap((queue) =>
        [queue.current, ...queue.interactive, ...queue.background].flatMap((job) =>
          job?.trace ? [job.trace] : [],
        ),
      ),
    ),
  };
}
