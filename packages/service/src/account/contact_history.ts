import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { contactHistoryWorker } from './contact_history_worker';
import type { ContactMetricRows } from './contact_metrics';
import { validGroupProfile, validGroupRosterMember } from './contact_cache_validation';

export function canonicalContactValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalContactValue).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalContactValue(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export interface ContactObservation {
  entity: string;
  category: string;
  source: 'local' | 'online' | 'legacy';
  scope?: string;
  completeness?: 'partial' | 'complete' | 'page';
  value: unknown;
  at?: number;
}
export interface ContactHistoryRow {
  id: number;
  category: string;
  source: string;
  scope: string;
  completeness: string;
  first_at: number;
  last_at: number;
}
export interface ContactHistoryVersion extends ContactHistoryRow {
  value: unknown;
  observedValue?: unknown;
}

/** BigInt、Map、二进制均带类型封装，避免 JSON 丢字段或损失整数精度。 */
export function encodeContactValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
  if (value === undefined) return { $type: 'undefined' };
  if (value instanceof Uint8Array)
    return { $type: 'bytes', value: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return { $type: 'date', value: value.toISOString() };
  if (value instanceof Map)
    return {
      $type: 'map',
      value: [...value].map(([key, item]) => [encodeContactValue(key), encodeContactValue(item)]),
    };
  if (value instanceof Set) return { $type: 'set', value: [...value].map(encodeContactValue) };
  if (Array.isArray(value)) return value.map(encodeContactValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, encodeContactValue(item)]);
    return Object.hasOwn(value, '$type')
      ? { $type: 'object', value: entries }
      : Object.fromEntries(entries);
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    return { $type: 'number', value: String(value) };
  return value;
}
export function decodeContactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeContactValue);
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  if (row.$type === 'bigint') return BigInt(String(row.value));
  if (row.$type === 'undefined') return undefined;
  if (row.$type === 'bytes') return Buffer.from(String(row.value), 'base64');
  if (row.$type === 'date') return new Date(String(row.value));
  if (row.$type === 'number') return Number(row.value);
  if (row.$type === 'map')
    return new Map(
      (row.value as unknown[][]).map(([key, item]) => [
        decodeContactValue(key),
        decodeContactValue(item),
      ]),
    );
  if (row.$type === 'set') return new Set((row.value as unknown[]).map(decodeContactValue));
  if (row.$type === 'object')
    return Object.fromEntries(
      (row.value as Array<[string, unknown]>).map(([key, item]) => [key, decodeContactValue(item)]),
    );
  return Object.fromEntries(
    Object.entries(row).map(([key, item]) => [key, decodeContactValue(item)]),
  );
}

export class ContactHistoryService {
  private readonly worker: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private closed = false;
  private failure?: Error;
  readonly migration: Promise<void>;
  readonly migrationErrors: string[] = [];
  lastError: string | null = null;
  private migrating = true;
  private failedCaptures: Array<{
    observations: ContactObservation[];
    links: Array<{ uid: string; uin: string }>;
  }> = [];
  private waiting: Array<() => void> = [];
  private captures = new Set<Promise<void>>();
  private admissions = 0;
  private accepting = true;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  constructor(readonly root: string) {
    this.worker = new Worker(
      `(${contactHistoryWorker.toString()})(${encodeContactValue.toString()},require)`,
      {
        eval: true,
        workerData: { path: join(root, 'history.sqlite') },
        execArgv:
          Number(process.versions.node.split('.')[0]) === 22 &&
          Number(process.versions.node.split('.')[1]) < 13
            ? ['--experimental-sqlite']
            : [],
      },
    );
    this.worker.unref();
    this.worker.on('message', (reply: { id: number; value?: unknown; error?: string }) => {
      const task = this.pending.get(reply.id);
      if (!task) return;
      this.pending.delete(reply.id);
      if (reply.error) {
        this.lastError = reply.error;
        task.reject(new Error(reply.error));
      } else task.resolve(reply.value);
      this.waiting.shift()?.();
      if (!this.pending.size) this.worker.unref();
    });
    const fail = (error: Error) => {
      this.failure = error;
      this.lastError = error.message;
      for (const task of this.pending.values()) task.reject(error);
      this.pending.clear();
      for (const wake of this.waiting.splice(0)) wake();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => {
      if (!this.closed) fail(new Error(`历史存储进程已退出：${code}`));
    });
    this.migration = this.migrate()
      .catch((error: unknown) => {
        this.lastError = String(error);
        this.migrationErrors.push(String(error));
      })
      .finally(() => {
        this.migrating = false;
      });
  }
  private async request<T>(method: string, input: object = {}): Promise<T> {
    while (this.pending.size >= 64 && !this.failure && !this.closed)
      await new Promise<void>((done) => this.waiting.push(done));
    if (this.closed || this.failure) throw this.failure ?? new Error('历史存储已关闭');
    const id = ++this.sequence;
    this.worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, method, input });
      } catch (error) {
        this.pending.delete(id);
        if (!this.pending.size) this.worker.unref();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async observe(input: ContactObservation) {
    await this.migration;
    return this.request<number>('observe', { ...input, value: encodeContactValue(input.value) });
  }
  /** 正常读取无需等待写盘；缓冲达到上限后才向调用方施加背压。 */
  async capture(
    observations: ContactObservation[],
    links: Array<{ uid: string; uin: string }> = [],
  ) {
    if (!this.accepting) return;
    if (this.failedCaptures.length >= 32) throw new Error('资料历史保存失败，待重试缓冲已满');
    observations = structuredClone(observations);
    this.admissions++;
    try {
      while (this.captures.size >= 32) await Promise.race(this.captures);
      const task = new Promise<void>((done) => setImmediate(done))
        .then(async () => {
          await this.migration;
          await this.request('batch', { links, observations, raw: true });
          if (!this.failedCaptures.length) this.lastError = null;
        })
        .catch((error: unknown) => {
          this.failedCaptures.push({ observations, links });
          this.lastError = error instanceof Error ? error.message : String(error);
          console.error('[contacts] 历史保存失败', error);
          this.scheduleRetry();
        });
      this.captures.add(task);
      void task.finally(() => {
        this.captures.delete(task);
        if (!this.captures.size && !this.checkpointTimer && this.accepting) {
          this.checkpointTimer = setTimeout(() => {
            this.checkpointTimer = undefined;
            if (this.accepting && !this.captures.size && !this.admissions && !this.pending.size)
              void this.request('flush').catch((error: unknown) => {
                this.lastError = String(error);
              });
          }, 2000);
          this.checkpointTimer.unref();
        }
      });
    } finally {
      this.admissions--;
    }
  }
  private async drain() {
    while (this.captures.size || this.admissions) {
      if (this.captures.size) await Promise.all([...this.captures]);
      else await new Promise<void>((done) => setImmediate(done));
    }
  }
  private scheduleRetry() {
    if (!this.accepting || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush().catch(() => this.scheduleRetry());
    }, 5000);
    this.retryTimer.unref();
  }
  async link(uid: string, uin: string) {
    await this.migration;
    await this.request('link', { uid, uin });
  }
  async list(entity: string, category = '', before?: number, limit = 30) {
    await this.migration;
    await this.drain();
    return this.request<{ rows: ContactHistoryRow[]; nextBefore: number | null }>('list', {
      entity,
      category,
      before,
      limit: Math.min(100, Math.max(1, limit)),
    });
  }
  async version(entity: string, id: number) {
    await this.migration;
    await this.drain();
    return this.request<ContactHistoryVersion>('version', { entity, id });
  }
  async diff(entity: string, id: number) {
    const current = await this.version(entity, id);
    const previous = await this.request<ContactHistoryVersion | null>('previous', { entity, id });
    return { current, previous };
  }
  async latest(input: Omit<ContactObservation, 'value' | 'at'>) {
    await this.migration;
    await this.drain();
    const row = await this.request<ContactHistoryVersion | null>('latest', input);
    return row ? { ...row, value: decodeContactValue(row.value) } : null;
  }
  async projections(waitForMigration = true) {
    if (waitForMigration) await this.migration;
    return decodeContactValue(await this.request('projections')) as ContactMetricRows;
  }
  async memberGroups() {
    await this.migration;
    await this.drain();
    return this.request<string[]>('groups');
  }
  async categories(entity: string) {
    await this.migration;
    await this.drain();
    return this.request<string[]>('categories', { entity });
  }
  async saveProjections(rows: ContactMetricRows) {
    await this.migration;
    await this.request('projection', { rows, replace: true });
  }
  async status() {
    const data = await this.request<{ versions: number; contents: number; bytes: number }>(
      'status',
    );
    return {
      ...data,
      migrating: this.migrating,
      pendingRetries: this.failedCaptures.length,
      lastError: this.lastError,
      migrationErrors: [...this.migrationErrors],
    };
  }
  flush(): Promise<void> {
    this.flushing ??= this.flushOnce().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  private async flushOnce() {
    await this.migration;
    await this.drain();
    for (const batch of [...this.failedCaptures]) {
      await this.request('batch', {
        links: batch.links,
        observations: batch.observations,
        raw: true,
      });
      this.failedCaptures.splice(this.failedCaptures.indexOf(batch), 1);
    }
    if (!this.failedCaptures.length) this.lastError = null;
    await this.request('flush');
  }
  async dispose() {
    if (this.closed) return;
    this.accepting = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    try {
      await this.flush();
      await this.drain();
      await this.flush();
      await this.request('close');
    } finally {
      this.closed = true;
      await this.worker.terminate();
    }
  }
  private async migrate() {
    await this.request('status');
    const files = ['metrics.json'];
    for (const dir of ['group-profiles', 'group-members']) {
      try {
        for (const name of await readdir(join(this.root, dir)))
          if (/^\d+\.json$/.test(name)) files.push(join(dir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          this.migrationErrors.push(`${dir}: ${String(error)}`);
      }
    }
    for (const file of files) {
      try {
        const path = join(this.root, file),
          text = await readFile(path, 'utf8');
        const hash = createHash('sha256').update(text).digest('hex');
        if (await this.request<boolean>('migrated', { path: file, hash })) {
          if (
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex') === hash
          )
            await unlink(path);
          else this.migrationErrors.push(`${file}: 迁移期间内容已更新，保留新文件`);
          continue;
        }
        const data = JSON.parse(text);
        if (data.version !== 1) throw new Error('旧缓存版本不支持，保留原件');
        if (file === 'metrics.json') {
          if (!data.rows || typeof data.rows !== 'object' || Array.isArray(data.rows))
            throw new Error('指标格式错误');
          const rows = Object.entries(data.rows),
            at = Date.now();
          for (let offset = 0; offset < rows.length; offset += 200)
            await this.request('importMetrics', {
              rows: Object.fromEntries(rows.slice(offset, offset + 200)),
              at,
            });
        } else {
          const groupId = file.split(/[\\/]/).at(-1)!.slice(0, -5);
          const members = file.startsWith('group-members');
          if (
            members
              ? !Array.isArray(data.members) || !data.members.every(validGroupRosterMember)
              : !validGroupProfile(data.profile) || String(data.groupId) !== groupId
          )
            throw new Error('旧群资料格式错误');
          const value = members ? data.members : data.profile;
          const id = await this.request<number>('observe', {
            entity: `group:${groupId}`,
            category: members ? 'members' : 'extendedProfile',
            source: 'legacy',
            completeness: 'complete',
            value: encodeContactValue(value),
            at: data.updatedAt ?? Date.now(),
          });
          const restored = await this.request<ContactHistoryVersion>('version', {
            entity: `group:${groupId}`,
            id,
          });
          if (
            canonicalContactValue(decodeContactValue(restored.value)) !==
            canonicalContactValue(value)
          )
            throw new Error('迁移校验失败');
        }
        await this.request('migration', { path: file, hash });
        if (
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex') === hash
        )
          await unlink(path);
        else this.migrationErrors.push(`${file}: 迁移期间内容已更新，保留新文件`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          this.migrationErrors.push(`${file}: ${String(error)}`);
      }
    }
    await this.request('flush');
  }
}
