import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as deadlineTimer, clearTimeout as clearDeadlineTimer } from 'node:timers';
import { performanceWorker } from './worker';
import {
  DEFAULT_MONITOR_SETTINGS,
  type MonitorSettings,
  type MonitorCollection,
  type MonitorMode,
  type MonitorRecord,
  type MonitorHistory,
  type MonitorRange,
  type MonitorStorageStatus,
} from './types';
export * from './types';

export function sqliteWorkerExecArgv(version: string): string[] | undefined {
  const [major, minor] = version.split('.').map(Number);
  return (major === 22 && minor! < 13) || (major === 23 && minor! < 4)
    ? ['--experimental-sqlite']
    : undefined;
}

export interface MonitorCollector {
  host: 'desktop' | 'web';
  capabilities: string[];
  activate(mode: MonitorMode): void;
  collect(detailed: boolean): Promise<MonitorCollection>;
  dispose(): void;
}
export function normalizeMonitorSettings(value: unknown): MonitorSettings {
  const row = value as Partial<MonitorSettings> | null;
  if (
    row?.version !== 1 ||
    !['off', 'light', 'full'].includes(row.mode ?? '') ||
    !Number.isInteger(row.retentionDays) ||
    row.retentionDays! < 1 ||
    row.retentionDays! > 365 ||
    ![64, 128, 256, 512].includes(row.capacityMiB ?? 0) ||
    (row.fullUntil !== null &&
      (typeof row.fullUntil !== 'number' || !Number.isFinite(row.fullUntil) || row.fullUntil < 0))
  )
    throw new Error('性能监视设置格式无效');
  return {
    version: 1,
    mode: row.mode!,
    retentionDays: row.retentionDays!,
    capacityMiB: row.capacityMiB!,
    fullUntil: row.mode === 'full' ? row.fullUntil! : null,
  };
}

export class PerformanceMonitor {
  readonly session = randomUUID();
  readonly ready: Promise<void>;
  settings = { ...DEFAULT_MONITOR_SETTINGS };
  private worker?: Worker;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private sequence = 0;
  private segment = randomUUID();
  private queue: MonitorRecord[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private maintenance?: ReturnType<typeof setInterval>;
  private collecting?: Promise<void>;
  private flushing?: Promise<void>;
  private disposed = false;
  private initialized = false;
  private maintaining = false;
  private epoch = 0;
  private nextRetry = 0;
  private detailAt = 0;
  private lastTick = 0;
  private storage: MonitorStorageStatus = { bytes: 0, oldest: null, newest: null, records: 0 };
  private error: string | null = null;
  private dropped = 0;
  private deferred = 0;
  private lastSampleAt: number | null = null;
  private lastSyncMs: number | null = null;
  private lastWaitMs: number | null = null;
  private detailBackoffUntil: number | null = null;
  private mutations: Promise<unknown> = Promise.resolve();
  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const task = this.mutations.then(run);
    this.mutations = task.catch(() => {});
    return task;
  }
  constructor(
    readonly root: string,
    readonly collector: MonitorCollector,
  ) {
    this.ready = this.initialize();
  }
  private startWorker() {
    const worker = new Worker(`(${performanceWorker.toString()})(require)`, {
      eval: true,
      execArgv: sqliteWorkerExecArgv(process.versions.node),
      workerData: { path: join(this.root, 'performance-monitor', 'history.sqlite') },
    });
    this.worker = worker;
    worker.on('message', (reply: { id: number; value: unknown; error?: string }) => {
      const request = this.pending.get(reply.id);
      if (!request) return;
      clearDeadlineTimer(request.timer);
      this.pending.delete(reply.id);
      if (reply.error) request.reject(new Error(reply.error));
      else request.resolve(reply.value);
      if (!this.pending.size) worker.unref();
    });
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.failed(error);
      for (const request of this.pending.values()) {
        clearDeadlineTimer(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      void worker.terminate();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`性能存储已退出 (${code})`)));
    worker.unref();
  }
  private request<T>(method: string, input: object = {}): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('性能历史存储不可用'));
    if (this.pending.size >= 16) return Promise.reject(new Error('性能历史查询繁忙，请稍后重试'));
    const id = ++this.sequence;
    worker.ref();
    return new Promise<T>((resolve, reject) => {
      const timer = deadlineTimer(() => {
        this.pending.delete(id);
        reject(new Error('性能历史操作超时'));
        if (!this.pending.size) worker.unref();
      }, 30_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      worker.postMessage({ id, method, input });
    });
  }
  private failed(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
    this.nextRetry = Date.now() + 60_000;
  }
  private async initialize() {
    try {
      this.startWorker();
      const raw = await this.request<string | null>('settings');
      this.settings = raw
        ? normalizeMonitorSettings(JSON.parse(raw))
        : { ...DEFAULT_MONITOR_SETTINGS };
      if (
        this.settings.mode === 'full' &&
        this.settings.fullUntil !== null &&
        this.settings.fullUntil <= Date.now()
      )
        this.settings = { ...this.settings, mode: 'light', fullUntil: null };
      await this.request('configure', { settings: this.settings });
      this.initialized = true;
      this.event('startup');
      this.reschedule();
    } catch (error) {
      this.failed(error);
      this.collector.activate('off');
    }
    if (!this.disposed) {
      this.maintenance = setInterval(() => {
        void this.maintain();
      }, 60_000);
      this.maintenance.unref();
    }
  }
  private async maintain() {
    if (this.disposed || this.maintaining || Date.now() < this.nextRetry) return;
    this.maintaining = true;
    try {
      if (!this.worker) {
        this.startWorker();
        this.initialized = false;
      }
      if (!this.initialized) {
        const raw = await this.request<string | null>('settings');
        this.settings = raw ? normalizeMonitorSettings(JSON.parse(raw)) : this.settings;
        if (
          this.settings.mode === 'full' &&
          this.settings.fullUntil !== null &&
          this.settings.fullUntil <= Date.now()
        )
          this.settings = { ...this.settings, mode: 'light', fullUntil: null };
        await this.request('configure', { settings: this.settings });
        this.initialized = true;
        this.reschedule();
      }
      await this.expire();
      await this.flush();
      await this.request('prune', { settings: this.settings });
      this.storage = await this.request('status');
      this.error = null;
    } catch (error) {
      this.failed(error);
    } finally {
      this.maintaining = false;
    }
  }
  private interval() {
    return this.settings.mode === 'full' ? 10_000 : 30_000;
  }
  private event(event: string, reason?: string) {
    if (this.settings.mode === 'off' || this.disposed) return;
    this.enqueue({
      version: 1,
      session: this.session,
      segment: this.segment,
      at: Date.now(),
      kind: 'event',
      intervalMs: this.interval(),
      event,
      reason,
    });
  }
  recordEvent(event: 'renderer-exit' | 'renderer-unavailable', reason?: string) {
    this.event(event, reason);
  }
  private enqueue(record: MonitorRecord) {
    if (this.queue.length === 120) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(record);
  }
  private reschedule() {
    clearTimeout(this.timer);
    clearTimeout(this.expiry);
    clearInterval(this.flushTimer);
    this.timer = undefined;
    this.expiry = undefined;
    this.flushTimer = undefined;
    this.collector.activate(this.disposed ? 'off' : this.settings.mode);
    if (this.settings.mode === 'off' || this.disposed) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 10_000);
    this.flushTimer.unref();
    if (this.settings.mode === 'full' && this.settings.fullUntil !== null) {
      this.expiry = setTimeout(
        () => {
          void this.expire();
        },
        Math.max(0, this.settings.fullUntil - Date.now()),
      );
      this.expiry.unref();
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, 0);
    this.timer.unref();
  }
  private async expire() {
    if (
      this.settings.mode === 'full' &&
      this.settings.fullUntil !== null &&
      this.settings.fullUntil <= Date.now()
    ) {
      try {
        await this.configure({ ...this.settings, mode: 'light', fullUntil: null });
      } catch (error) {
        // 到期即停止完整采集，即使设置暂时写不进去也不继续完整档。
        this.settings = { ...this.settings, mode: 'light', fullUntil: null };
        this.epoch++;
        this.reschedule();
        this.failed(error);
      }
    }
  }
  private async tick() {
    if (this.disposed || this.settings.mode === 'off') return;
    if (this.collecting) {
      this.deferred++;
      return;
    }
    const epoch = this.epoch,
      at = Date.now(),
      interval = this.interval();
    if (this.lastTick && at - this.lastTick > interval * 2.5) {
      this.segment = randomUUID();
      this.event('sampling-gap');
      this.collector.activate(this.settings.mode);
    }
    this.lastTick = at;
    const detailed = this.settings.mode === 'full' && at >= this.detailAt;
    if (detailed)
      this.detailAt =
        at + (this.detailBackoffUntil && at < this.detailBackoffUntil ? 120_000 : 30_000);
    this.collecting = (async () => {
      try {
        const result = await this.collector.collect(detailed);
        if (epoch !== this.epoch || this.disposed || this.settings.mode === 'off') return;
        this.lastSyncMs = result.syncMs;
        this.lastWaitMs = result.waitMs;
        this.lastSampleAt = at;
        if ((result.detailSyncMs ?? 0) > 16) {
          this.detailBackoffUntil = at + 300_000;
          this.detailAt = at + 120_000;
          this.deferred++;
        } else if (this.detailBackoffUntil && at >= this.detailBackoffUntil)
          this.detailBackoffUntil = null;
        this.enqueue({
          version: 1,
          session: this.session,
          segment: this.segment,
          kind: 'sample',
          at,
          intervalMs: interval,
          processes: result.processes,
          syncMs: result.syncMs,
          waitMs: result.waitMs,
          unavailable: result.unavailable,
        });
      } catch {
        if (epoch === this.epoch) {
          this.deferred++;
          this.event('sample-unavailable');
        }
      }
    })();
    await this.collecting;
    this.collecting = undefined;
    if (!this.disposed && epoch === this.epoch) {
      const elapsed = Date.now() - at,
        next = this.interval();
      this.timer = setTimeout(
        () => {
          void this.tick();
        },
        elapsed >= next ? next : Math.max(0, next - elapsed),
      );
      this.timer.unref();
    }
  }
  async configure(settings: MonitorSettings) {
    return this.mutate(() => this.configureNow(settings));
  }
  private async configureNow(settings: MonitorSettings) {
    const next = normalizeMonitorSettings(settings);
    if (next.mode === 'full' && next.fullUntil !== null && next.fullUntil <= Date.now()) {
      next.mode = 'light';
      next.fullUntil = null;
    }
    clearTimeout(this.timer);
    this.epoch++;
    await this.collecting;
    try {
      await this.request('configure', { settings: next });
    } catch (error) {
      this.reschedule();
      throw error;
    }
    const previous = this.settings.mode;
    this.settings = next;
    this.initialized = true;
    this.epoch++;
    this.segment = randomUUID();
    this.lastTick = 0;
    this.detailAt = 0;
    // 关闭也留下最后一个切换事件，但关闭后不再记录性能事件。
    if (next.mode === 'off' && previous !== 'off') {
      this.enqueue({
        version: 1,
        session: this.session,
        segment: this.segment,
        kind: 'event',
        at: Date.now(),
        intervalMs: 0,
        event: 'mode-off',
      });
    } else this.event(`mode-${next.mode}`);
    await this.collecting;
    this.reschedule();
    await this.flush();
    return this.settings;
  }
  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.queue.length || !this.worker || Date.now() < this.nextRetry) return;
    const records = this.queue.splice(0);
    this.flushing = (async () => {
      try {
        await this.request('batch', { records, settings: this.settings });
        this.error = null;
      } catch (error) {
        this.dropped += records.length;
        this.failed(error);
      }
    })();
    await this.flushing;
    this.flushing = undefined;
  }
  async status() {
    await this.ready;
    await this.mutations;
    if (this.worker && Date.now() >= this.nextRetry)
      try {
        this.storage = await this.request('status');
      } catch (error) {
        this.failed(error);
      }
    return {
      ...this.storage,
      host: this.collector.host,
      capabilities: this.collector.capabilities,
      settings: this.settings,
      session: this.session,
      queued: this.queue.length,
      dropped: this.dropped,
      deferred: this.deferred,
      collecting: !!this.collecting,
      writing: !!this.flushing,
      lastSampleAt: this.lastSampleAt,
      lastSyncMs: this.lastSyncMs,
      lastWaitMs: this.lastWaitMs,
      error: this.error,
      detailIntervalMs: this.detailBackoffUntil ? 120_000 : 30_000,
      detailBackoffUntil: this.detailBackoffUntil,
    };
  }
  async history(range: MonitorRange) {
    await this.ready;
    return this.request<MonitorHistory>('history', range);
  }
  async detail(id: number) {
    await this.ready;
    return this.request<MonitorRecord | null>('detail', { id });
  }
  async exportPage(from: number, to: number, after = 0) {
    await this.ready;
    return this.request<{ rows: string[]; next: number | null }>('export', { from, to, after });
  }
  async clear() {
    return this.mutate(() => this.clearNow());
  }
  async exportFile(path: string, range: MonitorRange, format: 'jsonl' | 'csv') {
    await this.ready;
    await this.flush();
    await this.request('export-file', { path, range, format });
  }
  private async clearNow() {
    await this.ready;
    clearTimeout(this.timer);
    this.epoch++;
    await this.collecting;
    await this.flushing;
    this.queue = [];
    try {
      await this.request('clear');
      this.segment = randomUUID();
    } finally {
      this.reschedule();
    }
  }
  async dispose() {
    if (this.disposed) return;
    if (this.initialized) this.event('shutdown');
    this.disposed = true;
    this.epoch++;
    clearTimeout(this.timer);
    clearTimeout(this.expiry);
    clearInterval(this.flushTimer);
    clearInterval(this.maintenance);
    this.collector.dispose();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      (async () => {
        await this.ready;
        await this.mutations;
        await this.collecting;
        await this.flush();
        if (this.worker) await this.request('close');
      })().catch(() => {}),
      new Promise<void>((resolve) => {
        deadline = deadlineTimer(resolve, 1500);
      }),
    ]);
    clearDeadlineTimer(deadline);
    const worker = this.worker;
    this.worker = undefined;
    for (const task of this.pending.values()) {
      clearDeadlineTimer(task.timer);
      task.reject(new Error('性能监视已关闭'));
    }
    this.pending.clear();
    await worker?.terminate();
  }
}

let current: PerformanceMonitor | undefined;
export function installPerformanceMonitor(root: string, collector: MonitorCollector) {
  if (current) throw new Error('宿主性能监视已经启动');
  current = new PerformanceMonitor(root, collector);
  return current;
}
export function getPerformanceMonitor() {
  if (!current) throw new Error('当前宿主尚未启动性能监视');
  return current;
}
