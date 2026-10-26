import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

export type DatabasePriority = 'interactive' | 'background';
const priority = new AsyncLocalStorage<{ priority: DatabasePriority; signal?: AbortSignal }>();
export function withDatabasePriority<T>(
  value: DatabasePriority,
  run: () => T,
  signal?: AbortSignal,
): T {
  return priority.run({ priority: value, signal }, run);
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
}
const queues = new Map<string, Queue>();
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

/** JS 侧非抢占调度；不把 native Promise 总耗时冒称原生执行耗时。 */
export function scheduleDatabase<T>(
  dbPath: string,
  run: () => Promise<T>,
  binding: object = defaultBinding,
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
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const pending = state[kind].indexOf(job);
      if (pending < 0) return;
      state[kind].splice(pending, 1);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('数据库读取已取消', 'AbortError'));
    };
    const job: Job = {
      at: performance.now(),
      priority: kind,
      signal,
      abort,
      async start() {
        signal?.removeEventListener('abort', abort);
        record(data.wait, performance.now() - job.at);
        const began = performance.now();
        try {
          const result = await run();
          if (Array.isArray(result)) data.rows += result.length;
          resolve(result);
        } catch (error) {
          data.failed++;
          reject(error);
        } finally {
          record(data.nativeAwait, performance.now() - began);
          if (kind === 'interactive') data.lastInteractiveAt = performance.now();
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
            await next.start();
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
): Promise<boolean> {
  const key = resolve(dbPath);
  while (current()) {
    const active = [...queues.values()].some(
      (queue) =>
        queue.path === key &&
        (queue.running || queue.interactive.length || queue.background.length),
    );
    const data = metric(key);
    if (!active && performance.now() - data.lastInteractiveAt >= quietMs) return true;
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
  };
}
