import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import type { DatabaseReadTiming, NtHelperBinding } from '@weq/native';
import { databaseUnderMaintenance } from './maintenance';
import {
  beginQueryTrace,
  databaseQueryDiagnostics,
  withDatabaseWorkPhase,
  type QuerySource,
  type QueryTrace,
} from './query_diagnostics';

export type DatabasePriority = 'interactive' | 'background';
export type DatabaseWorkload = 'latency' | 'bulk';
export const DEFAULT_DATABASE_READ_CONCURRENCY = 4;
export const MAX_DATABASE_READ_CONCURRENCY = 8;
let readConcurrency = DEFAULT_DATABASE_READ_CONCURRENCY;
let activeReadJobs = 0;
let nextJobSequence = 0;
const configuredBindings = new Set<NtHelperBinding>();
const execution = new AsyncLocalStorage<{ job: Job; path: string }>();
export function normalizeDatabaseReadConcurrency(
  value: unknown,
  fallback = DEFAULT_DATABASE_READ_CONCURRENCY,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_DATABASE_READ_CONCURRENCY
    ? value
    : fallback;
}
export function configureDatabaseReadConcurrency(value: number): void {
  if (normalizeDatabaseReadConcurrency(value, 0) === 0)
    throw new Error('数据库读取并发上限必须为 1–8 的整数');
  for (const binding of configuredBindings) binding.configureDatabaseReads?.(value);
  readConcurrency = value;
  for (const queue of queues.values()) queue.pump?.();
}
export function prepareDatabaseReadBinding(binding: NtHelperBinding): void {
  const root = (bindingAliases.get(binding) ?? binding) as NtHelperBinding;
  if (configuredBindings.has(root)) return;
  root.configureDatabaseReads?.(readConcurrency);
  configuredBindings.add(root);
}
export function currentDatabaseRead() {
  const job = execution.getStore()?.job;
  return {
    bulk: (job?.workload ?? priority.getStore()?.workload) === 'bulk',
    signal: job?.signal ?? databaseRequestSignal(),
  };
}
export function recordNativeReadTiming(timing: DatabaseReadTiming): void {
  const scope = execution.getStore();
  if (!scope) return;
  scope.job.nativeTiming = timing;
  const data = metric(scope.path);
  record(data.nativeQueue, timing.nativeQueueMs);
  record(data.connectionWait, timing.connectionWaitMs);
  record(data.connectionOpen, timing.connectionOpenMs);
  record(data.execution, timing.executionMs);
}
export const SLOW_DATABASE_OPERATION_MS = 500;
export interface SlowDatabaseOperation {
  priority: DatabasePriority;
  jsQueueWaitMs: number;
  nativePromiseAwaitMs: number;
  nativeTiming?: DatabaseReadTiming;
  affectedQueryCount?: number;
  /** 仅本操作占用队列期间造成的阻塞，不含此前排队及取消后的时间。 */
  maxBlockedMs?: number;
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
const priority = new AsyncLocalStorage<{
  priority: DatabasePriority;
  workload?: DatabaseWorkload;
  signal?: AbortSignal;
}>();
export function withDatabaseWorkload<T>(workload: DatabaseWorkload, run: () => T): T {
  const inherited = priority.getStore();
  return priority.run(
    {
      get priority() {
        return inherited?.priority ?? 'interactive';
      },
      signal: inherited?.signal,
      workload,
    },
    run,
  );
}
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
export function databaseRequestPriority(): DatabasePriority {
  return priority.getStore()?.priority ?? 'interactive';
}
export function withDatabasePriority<T>(
  value: DatabasePriority,
  run: () => T,
  signal?: AbortSignal,
): T {
  return priority.run(
    {
      workload: priority.getStore()?.workload ?? (value === 'background' ? 'bulk' : 'latency'),
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
      workload: inherited?.workload,
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
  sequence: number;
  read: boolean;
  workload: DatabaseWorkload;
  nativeTiming?: DatabaseReadTiming;
  trace?: QueryTrace;
  at: number;
  startedAtMs?: number;
  cancelledQueryCount?: number;
  maxCancelledBlockMs?: number;
  priority: DatabasePriority;
  signal?: AbortSignal;
  start(): Promise<void>;
  abort(): void;
}
interface Queue {
  binding: object;
  active: Set<Job>;
  pump?: () => void;
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
    for (const job of queue.active) {
      if (job.signal !== signal) continue;
      job.priority = 'interactive';
      if (job.trace) job.trace.priority = 'interactive';
      metric(queue.path).lastInteractiveAt = performance.now();
    }
    const jobs = queue.background.filter((job) => job.signal === signal);
    queue.background = queue.background.filter((job) => job.signal !== signal);
    for (const job of jobs) {
      job.priority = 'interactive';
      if (job.trace) job.trace.priority = 'interactive';
      queue.interactive.push(job);
    }
    queue.pump?.();
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
  | 'messageWatchWatermarks'
  | 'contactMembership'
  | 'unreadSmallTables'
  | 'unreadSnapshotProjection'
  | 'unreadDeviceAndGrayTipLookup'
  | 'unreadRecallLookup'
  | 'unreadRecallExtents'
  | 'unreadRecallPresence'
  | 'unreadSnapshotApply'
  | 'unreadPersistence'
  | 'replyCache'
  | 'messagePage'
  | 'roamingCache';
const metrics = new Map<
  string,
  {
    wait: Series;
    nativeAwait: Series;
    nativeQueue: Series;
    connectionWait: Series;
    connectionOpen: Series;
    execution: Series;
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
      nativeQueue: series(),
      connectionWait: series(),
      connectionOpen: series(),
      execution: series(),
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
  options: { read?: boolean; bulk?: boolean } = {},
): Promise<T> {
  const path = resolve(dbPath),
    key = `${bindingId(binding)}:${path}`,
    context = priority.getStore();
  const kind = context?.priority ?? 'interactive',
    signal = context?.signal;
  if (signal?.aborted) return Promise.reject(new DOMException('数据库读取已取消', 'AbortError'));
  let queue = queues.get(key);
  if (!queue) {
    queue = {
      path,
      binding,
      active: new Set(),
      running: false,
      interactiveBurst: 0,
      interactive: [],
      background: [],
    };
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
      for (const running of state.active) {
        if (running.startedAtMs !== undefined) {
          const blockedMs = performance.now() - Math.max(job.at, running.startedAtMs);
          if (blockedMs > 0) {
            running.cancelledQueryCount = (running.cancelledQueryCount ?? 0) + 1;
            running.maxCancelledBlockMs = Math.max(running.maxCancelledBlockMs ?? 0, blockedMs);
          }
        }
      }
      if (job.trace) {
        job.trace.endedAtMs = performance.now();
        job.trace.outcome = 'cancelled';
      }
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('数据库读取已取消', 'AbortError'));
      state.pump?.();
      if (
        !state.active.size &&
        !state.interactive.length &&
        !state.background.length &&
        queues.get(key) === state
      )
        queues.delete(key);
    };
    const job: Job = {
      sequence: ++nextJobSequence,
      read: options.read === true,
      workload: options.bulk === true ? 'bulk' : (context?.workload ?? 'latency'),
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
        if (notifySlow) job.startedAtMs = began;
        let outcome: SlowDatabaseOperation['outcome'] = 'ok';
        if (job.trace) {
          job.trace.priority = job.priority;
          job.trace.startedAtMs = began;
          job.trace.outcome = 'running';
        }
        try {
          const result = await execution.run({ job, path }, run);
          if (job.read) signal?.throwIfAborted();
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
          const ended = performance.now();
          if (job.trace) job.trace.endedAtMs = ended;
          job.startedAtMs = undefined;
          const nativePromiseAwaitMs = ended - began;
          record(data.nativeAwait, nativePromiseAwaitMs);
          if (jsQueueWaitMs > observationThreshold || nativePromiseAwaitMs > observationThreshold) {
            let affectedQueryCount = job.cancelledQueryCount ?? 0;
            let maxBlockedMs = job.maxCancelledBlockMs ?? 0;
            // 只在慢操作结束时扫描其真实队列；快查询不增加逐请求关联或遍历。
            if (nativePromiseAwaitMs > observationThreshold) {
              for (const pending of [state.interactive, state.background]) {
                for (const waiting of pending) {
                  const blockedMs = ended - Math.max(waiting.at, began);
                  if (blockedMs <= 0) continue;
                  affectedQueryCount++;
                  maxBlockedMs = Math.max(maxBlockedMs, blockedMs);
                }
              }
            }
            notifySlow?.({
              priority: job.priority,
              jsQueueWaitMs,
              nativePromiseAwaitMs,
              ...(job.nativeTiming ? { nativeTiming: job.nativeTiming } : {}),
              outcome,
              ...(job.trace?.source ?? source ?? {}),
              ...(nativePromiseAwaitMs > observationThreshold && affectedQueryCount
                ? { affectedQueryCount, maxBlockedMs }
                : {}),
            });
          }
          if (job.priority === 'interactive') data.lastInteractiveAt = performance.now();
        }
      },
    };
    state[kind].push(job);
    signal?.addEventListener('abort', abort, { once: true });
    data.peakQueued = Math.max(data.peakQueued, state.interactive.length + state.background.length);
    const boundStart = AsyncLocalStorage.bind(job.start);
    job.start = boundStart;
    state.pump ??= () => {
      const capable =
        typeof (state.binding as Partial<NtHelperBinding>).executeDatabaseRead === 'function';
      const limit = capable ? readConcurrency : 1;
      if (state.active.size >= limit || [...state.active].some((item) => !item.read)) return;
      while (state.interactive.length || state.background.length) {
        const foreground =
          state.interactive.length > 0 && (state.interactiveBurst < 8 || !state.background.length);
        const pending = foreground ? state.interactive : state.background;
        const writeAt = Math.min(
          ...[...state.interactive, ...state.background]
            .filter((item) => !item.read)
            .map((item) => item.sequence),
          Infinity,
        );
        const eligible = (item: Job) => {
          if (!item.read) return state.active.size === 0;
          if (activeReadJobs >= 32) return false;
          if (item.sequence > writeAt) return false;
          return (
            item.workload !== 'bulk' ||
            ![...state.active].some((active) => active.workload === 'bulk')
          );
        };
        let index = pending.findIndex(eligible);
        let selected = pending;
        if (index < 0) {
          selected = foreground ? state.background : state.interactive;
          index = selected.findIndex(eligible);
        }
        if (index < 0) return;
        const next = selected.splice(index, 1)[0]!;
        state.interactiveBurst = selected === state.interactive ? state.interactiveBurst + 1 : 0;
        state.active.add(next);
        if (next.read) activeReadJobs++;
        state.running = true;
        state.current = state.active.values().next().value;
        void next.start().finally(() => {
          state.active.delete(next);
          if (next.read) activeReadJobs--;
          state.current = state.active.values().next().value;
          state.running = state.active.size > 0;
          if (!state.running && !state.interactive.length && !state.background.length) {
            if (queues.get(key) === state) queues.delete(key);
          }
          setImmediate(() => {
            for (const waiting of queues.values()) waiting.pump?.();
          });
        });
        if (!next.read || state.active.size >= limit) return;
      }
    };
    state.pump();
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
    if (
      !databaseUnderMaintenance(dbPath) &&
      !active &&
      performance.now() - data.lastInteractiveAt >= quietMs
    )
      return true;
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
    nativeExecutionMs: data.execution.count ? summary(data.execution) : null,
    nativeQueueMs: data.nativeQueue.count ? summary(data.nativeQueue) : null,
    connectionWait: summary(data.connectionWait),
    connectionOpen: summary(data.connectionOpen),
    configuredReadConcurrency: readConcurrency,
    queued: waiting.length,
    inFlight: active.reduce((sum, queue) => sum + queue.active.size, 0),
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
        [...queue.active, ...queue.interactive, ...queue.background].flatMap((job) =>
          job?.trace ? [job.trace] : [],
        ),
      ),
    ),
  };
}
