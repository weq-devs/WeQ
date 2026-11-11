import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ContactHistoryService } from './contact_history';

export type ContactMetric =
  | 'level'
  | 'likeCount'
  | 'addedAt'
  | 'direction'
  | 'commonFriends'
  | 'commonGroups'
  | 'friendCount'
  | 'activityScore'
  | 'energy'
  | 'source'
  | 'sourceGroup'
  | 'schools'
  | 'joinedAt'
  | 'grade'
  | 'freezeState';
export type MetricValue = number | string | string[] | Array<{ groupCode: string; name: string }>;
export interface MetricCell {
  value?: MetricValue;
  updatedAt?: number;
  attemptedAt: number;
  state: 'ready' | 'failed' | 'stale';
  error?: string;
}
export type ContactMetricRows = Record<string, Partial<Record<ContactMetric, MetricCell>>>;
export interface ContactMetricsSnapshot {
  revision: number;
  rows: ContactMetricRows;
}
export interface ContactMetricJob {
  key: string;
  label?: string;
  online?: boolean;
  run: () => Promise<unknown>;
}
export class ContactMetricsOfflineError extends Error {}
export interface ContactMetricsLane {
  done: number;
  total: number;
  failed: number;
}
export interface ContactMetricsProgress {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  done: number;
  total: number;
  failed: number;
  phase: string;
  lanes?: { friends: ContactMetricsLane; groups: ContactMetricsLane };
}

/** 账号共享的指标缓存；在线工作统一排队，缓存写入与展示事件有界合并。 */
export class ContactMetricsService extends EventEmitter {
  private rows: ContactMetricRows = {};
  private revision = 0;
  private active = true;
  private loaded: Promise<void>;
  private writes = Promise.resolve();
  private dirty = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private queue: Array<{ priority: number; run: () => void; cancel: () => void }> = [];
  private inflight = new Map<string, Promise<unknown>>();
  private running = 0;
  private lastStart = 0;
  private pumpTimer?: ReturnType<typeof setTimeout>;
  private sequences = new Map<string, number>();
  private jobs: ContactMetricJob[] = [];
  private failedJobs: ContactMetricJob[] = [];
  private jobRunning = false;
  private cancelled = false;
  private afterRun?: () => Promise<void>;
  progress: ContactMetricsProgress = {
    status: 'completed',
    done: 0,
    total: 0,
    failed: 0,
    phase: '',
  };

  constructor(
    private readonly path: string,
    private readonly isOnline: () => boolean,
    private readonly options = { interval: 500, concurrency: 2 },
    private readonly history?: ContactHistoryService,
  ) {
    super();
    this.loaded = this.load();
  }

  private async load() {
    let stored: ContactMetricRows = {};
    if (this.history) {
      try {
        stored = await this.history.projections(false);
        this.rows = stored;
      } catch (error) {
        console.warn('[contacts] 历史指标读取失败，尝试保留的旧缓存', error);
      }
    }
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (
        !data ||
        typeof data !== 'object' ||
        !('version' in data) ||
        data.version !== 1 ||
        !('rows' in data) ||
        !data.rows ||
        typeof data.rows !== 'object' ||
        Array.isArray(data.rows)
      )
        return;
      const parsed: ContactMetricRows = {};
      for (const [key, row] of Object.entries(data.rows)) {
        if (!/^(friend|group):[\w-]+$/.test(key) || !row || typeof row !== 'object') continue;
        const cells: Partial<Record<ContactMetric, MetricCell>> = {};
        for (const metric of CONTACT_METRICS) {
          const cell: unknown = Reflect.get(row, metric);
          if (
            !cell ||
            typeof cell !== 'object' ||
            !('attemptedAt' in cell) ||
            typeof cell.attemptedAt !== 'number'
          )
            continue;
          const value =
            'value' in cell && validMetricValue(metric, cell.value) ? cell.value : undefined;
          const failed = 'state' in cell && cell.state === 'failed';
          if (
            value !== undefined ||
            failed ||
            ('updatedAt' in cell && typeof cell.updatedAt === 'number')
          ) {
            cells[metric] = {
              value,
              attemptedAt: cell.attemptedAt,
              updatedAt:
                'updatedAt' in cell && typeof cell.updatedAt === 'number'
                  ? cell.updatedAt
                  : undefined,
              state: failed ? 'failed' : 'stale',
              error:
                failed && 'error' in cell && typeof cell.error === 'string'
                  ? cell.error
                  : undefined,
            };
          }
        }
        parsed[key] = cells;
      }
      this.rows = { ...parsed, ...stored };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[contacts] 缓存读取失败', error);
      if (this.history) {
        try {
          this.rows = await this.history.projections(false);
        } catch {
          this.rows = stored;
        }
      }
    }
  }

  async snapshot(): Promise<ContactMetricsSnapshot> {
    await this.loaded;
    return { revision: this.revision, rows: structuredClone(this.rows) };
  }
  async row(key: string) {
    await this.loaded;
    return structuredClone(this.rows[key] ?? {});
  }
  async keysForMetric(metric: ContactMetric) {
    await this.loaded;
    return Object.keys(this.rows).filter((key) => this.rows[key]?.[metric]);
  }

  private changed() {
    this.revision++;
    this.dirty = true;
    if (!this.eventTimer)
      this.eventTimer = setTimeout(() => {
        this.eventTimer = undefined;
        if (this.active) this.emit('changed', this.revision);
      }, 250);
    if (!this.flushTimer)
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush().catch((error) => console.error('[contacts] 缓存保存失败', error));
      }, 2000);
  }

  async flush() {
    await this.loaded;
    if (!this.dirty) return this.writes;
    this.dirty = false;
    if (this.history) {
      const rows = structuredClone(this.rows);
      this.writes = this.writes
        .catch(() => {})
        .then(async () => {
          await this.history!.saveProjections(rows);
        })
        .catch((error: unknown) => {
          this.dirty = true;
          throw error;
        });
      return this.writes;
    }
    const text = JSON.stringify({ version: 1, rows: this.rows });
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, text, 'utf8');
        await rename(tmp, this.path);
      })
      .catch((error) => {
        this.dirty = true;
        throw error;
      });
    return this.writes;
  }

  async record(key: string, values: Partial<Record<ContactMetric, MetricValue | null>>) {
    await this.loaded;
    if (!this.active) return;
    this.rows[key] ??= {};
    const row = this.rows[key];
    for (const metric of CONTACT_METRICS) {
      const value = values[metric];
      if (value === undefined || value === null || !validMetricValue(metric, value)) continue;
      const sequenceKey = `${key}:${metric}`;
      this.sequences.set(sequenceKey, (this.sequences.get(sequenceKey) ?? 0) + 1);
      row[metric] = { value, state: 'ready', attemptedAt: Date.now(), updatedAt: Date.now() };
      await this.remember(key, metric, value);
    }
    this.changed();
  }

  private async remember(entity: string, metric: ContactMetric, value: unknown, at?: number) {
    if (!this.history) return;
    try {
      await this.history.capture([
        { entity, category: `metric.${metric}`, source: 'local', value, at: at ?? Date.now() },
      ]);
    } catch (error) {
      console.error('[contacts] 指标历史保存失败', error);
    }
  }

  async failed(key: string, metric: ContactMetric, error: unknown) {
    await this.loaded;
    if (!this.active) return;
    this.rows[key] ??= {};
    const row = this.rows[key];
    row[metric] = {
      ...row[metric],
      attemptedAt: Date.now(),
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    this.changed();
  }
  /** 不适用的指标不保留缓存，并阻止在途旧查询重新写回。 */
  async removeMetrics(keys: string[], metrics: ContactMetric[]) {
    await this.loaded;
    if (!this.active) return;
    let changed = false;
    for (const key of keys)
      for (const metric of metrics) {
        const sequenceKey = `${key}:${metric}`;
        this.sequences.set(sequenceKey, (this.sequences.get(sequenceKey) ?? 0) + 1);
        const row = this.rows[key];
        if (row?.[metric]) {
          delete row[metric];
          changed = true;
          if (!Object.keys(row).length) delete this.rows[key];
        }
      }
    if (changed) this.changed();
  }
  async recordIfChanged(key: string, values: Partial<Record<ContactMetric, MetricValue | null>>) {
    await this.loaded;
    const changed: Partial<Record<ContactMetric, MetricValue | null>> = {};
    for (const metric of CONTACT_METRICS)
      if (
        values[metric] != null &&
        JSON.stringify(this.rows[key]?.[metric]?.value) !== JSON.stringify(values[metric])
      )
        changed[metric] = values[metric];
    if (Object.keys(changed).length) await this.record(key, changed);
  }

  /** 成功的完整投影允许显式清空缺省字段；失败更新继续保留旧值。 */
  async project(
    key: string,
    values: Partial<Record<ContactMetric, MetricValue | null>>,
    updatedAt = Date.now(),
  ) {
    await this.loaded;
    if (!this.active) return;
    this.rows[key] ??= {};
    for (const metric of CONTACT_METRICS) {
      if (!Object.hasOwn(values, metric)) continue;
      const value = values[metric];
      if (value !== null && !validMetricValue(metric, value)) continue;
      const token = `${key}:${metric}`;
      this.sequences.set(token, (this.sequences.get(token) ?? 0) + 1);
      this.rows[key][metric] = {
        value: value ?? undefined,
        state: 'ready',
        attemptedAt: updatedAt,
        updatedAt,
      };
      await this.remember(key, metric, value, updatedAt);
    }
    this.changed();
  }

  async stale(keys: string[], metrics: ContactMetric[]) {
    await this.loaded;
    if (!this.active) return;
    for (const key of keys)
      for (const metric of metrics) {
        const sequenceKey = `${key}:${metric}`;
        this.sequences.set(sequenceKey, (this.sequences.get(sequenceKey) ?? 0) + 1);
        const cell = this.rows[key]?.[metric];
        if (cell) cell.state = 'stale';
      }
    this.changed();
  }

  /** 同目标查询去重；普通读取默认优先于重建。 */
  schedule<T>(key: string, work: () => Promise<T>, priority = 0): Promise<T> {
    if (!this.active) return Promise.reject(new Error('账号已关闭'));
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        cancel: () => reject(new Error('账号已关闭')),
        run: () => {
          this.running++;
          Promise.resolve()
            .then(() => {
              if (!this.active) throw new Error('账号已关闭');
              return work();
            })
            .then((value) => {
              if (!this.active) throw new Error('账号已关闭');
              resolve(value);
            })
            .catch(reject)
            .finally(() => {
              this.running--;
              this.pump();
            });
        },
      });
      this.queue.sort((a, b) => a.priority - b.priority);
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    this.pump();
    return promise;
  }

  private pump() {
    if (this.pumpTimer || this.running >= this.options.concurrency || !this.queue.length) return;
    const wait = Math.max(0, this.lastStart + this.options.interval - Date.now());
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      const next = this.queue.shift();
      if (next) {
        this.lastStart = Date.now();
        next.run();
      }
      this.pump();
    }, wait);
  }

  async query<T>(
    key: string,
    metrics: ContactMetric[],
    work: () => Promise<T>,
    values: (value: T) => Partial<Record<ContactMetric, MetricValue | null>>,
    priority = 0,
  ): Promise<T> {
    return this.schedule(
      `${key}:${metrics.join(',')}`,
      async () => {
        await this.loaded;
        if (!this.active) throw new Error('账号已关闭');
        const tokens = new Map(
          metrics.map((metric) => {
            const id = `${key}:${metric}`,
              token = (this.sequences.get(id) ?? 0) + 1;
            this.sequences.set(id, token);
            return [metric, token];
          }),
        );
        try {
          const result = await work();
          if (!this.active) throw new Error('账号已关闭');
          this.rows[key] ??= {};
          const data = values(result),
            row = this.rows[key];
          for (const metric of metrics) {
            if (this.sequences.get(`${key}:${metric}`) !== tokens.get(metric)) continue;
            const value = data[metric],
              now = Date.now();
            row[metric] =
              value != null && validMetricValue(metric, value)
                ? { value, state: 'ready', attemptedAt: now, updatedAt: now }
                : { ...row[metric], state: 'failed', attemptedAt: now, error: '未返回有效数据' };
            if (value != null && validMetricValue(metric, value))
              await this.remember(key, metric, value, now);
          }
          this.changed();
          return result;
        } catch (error) {
          if (this.active) {
            this.rows[key] ??= {};
            const row = this.rows[key];
            for (const metric of metrics)
              if (this.sequences.get(`${key}:${metric}`) === tokens.get(metric))
                row[metric] = {
                  ...row[metric],
                  state: 'failed',
                  attemptedAt: Date.now(),
                  error: error instanceof Error ? error.message : String(error),
                };
            this.changed();
          }
          throw error;
        }
      },
      priority,
    );
  }

  start(jobs: ContactMetricJob[], phase = '好友在线指标', afterRun?: () => Promise<void>) {
    if (this.jobRunning || this.progress.status === 'paused') return false;
    this.jobs = [...jobs];
    this.failedJobs = [];
    this.cancelled = false;
    this.afterRun = afterRun;
    this.progress = { status: 'running', done: 0, total: jobs.length, failed: 0, phase };
    this.emit('log', `已准备 ${jobs.length} 项查询`);
    this.resetLanes();
    this.launch();
    return true;
  }

  cancel() {
    this.emit('log', '收到取消请求，等待在途查询结束后停止');
    this.cancelled = true;
    if (!this.jobRunning) this.updateProgress('cancelled');
  }
  resume() {
    if (this.jobRunning || !this.active) return;
    this.cancelled = false;
    this.emit('log', this.jobs.length ? '继续剩余查询' : '仅重试上次失败的查询');
    if (!this.jobs.length) {
      this.jobs = this.failedJobs.splice(0);
      this.progress.failed = 0;
      this.progress.done = 0;
      this.progress.total = this.jobs.length;
      this.resetLanes();
    }
    this.launch();
  }
  private launch() {
    void this.runJobs().catch((error) => {
      this.emit('log', `缓存任务失败：${error instanceof Error ? error.message : String(error)}`);
      this.progress.phase = '任务收尾失败';
      this.updateProgress('failed');
    });
  }
  private resetLanes() {
    const groups = this.jobs.filter((job) => job.key.startsWith('group:')).length;
    this.progress.lanes = {
      friends: { done: 0, total: this.jobs.length - groups, failed: 0 },
      groups: { done: 0, total: groups, failed: 0 },
    };
  }
  private updateProgress(status: ContactMetricsProgress['status']) {
    this.progress = { ...this.progress, status };
    this.emit('progress', structuredClone(this.progress));
    if (this.active) this.emit('changed', this.revision);
  }
  private async runJobs() {
    this.jobRunning = true;
    this.updateProgress('running');
    try {
      const blocked = new Set<ContactMetricJob>();
      const worker = async (group: boolean) => {
        while (this.active && !this.cancelled) {
          const index = this.jobs.findIndex(
            (job) => job.key.startsWith('group:') === group && !blocked.has(job),
          );
          if (index < 0) return;
          const job = this.jobs.splice(index, 1)[0]!;
          if (job.online !== false && !this.isOnline()) {
            blocked.add(job);
            this.jobs.push(job);
            continue;
          }
          const lane = this.progress.lanes?.[group ? 'groups' : 'friends'];
          this.emit('log', `开始：${job.label ?? job.key}`, group ? 'groups' : 'friends');
          try {
            await job.run();
            this.emit('log', `完成：${job.label ?? job.key}`, group ? 'groups' : 'friends');
          } catch (error) {
            if (error instanceof ContactMetricsOfflineError) {
              blocked.add(job);
              this.jobs.push(job);
              continue;
            }
            this.emit(
              'log',
              `失败：${job.label ?? job.key}；${error instanceof Error ? error.message : String(error)}`,
              group ? 'groups' : 'friends',
            );
            this.failedJobs.push(job);
            this.progress.failed++;
            if (lane) lane.failed++;
          }
          this.progress.done++;
          if (lane) lane.done++;
          this.progress.phase = this.progress.lanes?.friends.total
            ? this.progress.lanes.groups.total
              ? '好友与群聊并行读取'
              : '好友在线指标'
            : '群聊读取';
          this.updateProgress('running');
        }
      };
      await Promise.all([worker(false), worker(true)]);
      if (!this.jobs.length && !this.cancelled && this.active && this.afterRun) {
        this.progress.phase = '整理结果';
        this.updateProgress('running');
        await this.afterRun();
      }
      if (this.jobs.length && !this.cancelled && this.active)
        this.emit('log', 'QQ 当前不可在线查询，未完成部分已暂停，可在任务列表继续');
      await this.flush();
      this.jobRunning = false;
      const status =
        this.cancelled || !this.active
          ? 'cancelled'
          : this.jobs.length
            ? 'paused'
            : this.progress.failed
              ? 'failed'
              : 'completed';
      this.emit(
        'log',
        `${status === 'cancelled' ? '已取消' : '本轮结束'}：处理 ${this.progress.done}/${this.progress.total} 项，${this.progress.failed} 项未完成`,
      );
      this.updateProgress(status);
    } finally {
      this.jobRunning = false;
    }
  }

  async dispose() {
    this.active = false;
    this.cancelled = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    for (const queued of this.queue.splice(0)) queued.cancel();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.removeAllListeners();
    await this.flush();
  }
}

const CONTACT_METRICS: ContactMetric[] = [
  'level',
  'likeCount',
  'addedAt',
  'direction',
  'commonFriends',
  'commonGroups',
  'friendCount',
  'activityScore',
  'energy',
  'source',
  'sourceGroup',
  'schools',
  'joinedAt',
  'grade',
  'freezeState',
];
function validMetricValue(metric: ContactMetric, value: unknown): value is MetricValue {
  if (metric === 'schools')
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (metric === 'source' || metric === 'sourceGroup') return typeof value === 'string';
  if (metric === 'direction') return value === 'incoming' || value === 'outgoing';
  if (metric === 'commonGroups')
    return (
      Array.isArray(value) &&
      value.every(
        (row) =>
          row &&
          typeof row === 'object' &&
          typeof row.groupCode === 'string' &&
          /^\d+$/.test(row.groupCode) &&
          typeof row.name === 'string',
      )
    );
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    (metric === 'addedAt' ? value > 0 : value >= 0)
  );
}
