import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BackgroundTask } from '../shared/background_task';
import {
  backgroundResult,
  isTaskArchived,
  type TaskArchive,
  type TaskArchiveChange,
  type TaskArchiveEntry,
  type TaskArchivePatch,
} from '../shared/task_archive';

const requireFromHere = createRequire(import.meta.url);

function withForwardProgress(entry: TaskArchiveEntry): TaskArchiveEntry {
  const snapshot = entry.snapshot;
  // 旧版转发回执没有持久化进度，已完成的任务可以从状态恢复。
  return snapshot?.kind === 'forward' &&
    snapshot.status === 'completed' &&
    snapshot.progress === undefined
    ? { ...entry, snapshot: { ...snapshot, progress: 100 } }
    : entry;
}

function summarize(entry: TaskArchiveEntry): TaskArchiveEntry {
  if (!entry.snapshot) return entry;
  const {
    logs: _logs,
    details: _details,
    contactFailures: _failures,
    ...snapshot
  } = entry.snapshot;
  return { ...entry, snapshot };
}

export class TaskArchiveStore {
  readonly busy = new Set<string>();
  private readonly listeners = new Set<(change: TaskArchiveChange) => void>();
  private database?: DatabaseSync;
  private idle?: ReturnType<typeof setTimeout>;

  constructor(private readonly path: string) {}

  private open() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.database?.close();
      this.database = undefined;
    }, 30_000);
    this.idle.unref();
    if (this.database) return this.database;
    const { DatabaseSync } = requireFromHere('node:sqlite') as typeof import('node:sqlite');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(`${this.path.replace(/\.json$/, '')}.sqlite`);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100;
        CREATE TABLE IF NOT EXISTS task_archive (id TEXT PRIMARY KEY, summary TEXT NOT NULL, full TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS archive_sequence (id INTEGER PRIMARY KEY CHECK(id=0), generation TEXT NOT NULL, revision INTEGER NOT NULL);`);
      if (!db.prepare('SELECT revision FROM archive_sequence WHERE id=0').get()) {
        const legacy: TaskArchive = existsSync(this.path)
          ? (JSON.parse(readFileSync(this.path, 'utf8')) as TaskArchive)
          : {};
        this.transaction(db, () => {
          // 迁移与标记同批提交。另一窗口若已完成，沿用它持久化的归档。
          if (
            !db.prepare('INSERT OR IGNORE INTO archive_sequence VALUES(0,?,0)').run(randomUUID())
              .changes
          )
            return;
          this.write(db, Object.entries(legacy));
        });
      }
      this.database = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private transaction<T>(db: DatabaseSync, run: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private write(db: DatabaseSync, patch: [string, TaskArchiveEntry | null][]) {
    const upsert = db.prepare(`INSERT INTO task_archive VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET
      summary=excluded.summary,full=excluded.full`);
    const remove = db.prepare('DELETE FROM task_archive WHERE id=?');
    for (const [id, entry] of patch) {
      if (entry) upsert.run(id, JSON.stringify(summarize(entry)), JSON.stringify(entry));
      else remove.run(id);
    }
  }

  snapshot(): TaskArchive {
    return this.readRows(false).entries;
  }

  summaries() {
    return this.readRows(true);
  }

  private readRows(summary: boolean) {
    const column = summary ? 'summary' : 'full';
    const rows = this.open()
      .prepare(
        `SELECT generation,revision,t.id AS task_id,${column} AS value FROM archive_sequence s
       LEFT JOIN task_archive t ON 1 WHERE s.id=0 ORDER BY t.rowid`,
      )
      .all();
    return {
      generation: String(rows[0]?.generation),
      revision: Number(rows[0]?.revision ?? 0),
      entries: Object.fromEntries(
        rows.flatMap(({ task_id, value }) =>
          typeof task_id === 'string' && typeof value === 'string'
            ? [[task_id, withForwardProgress(JSON.parse(value) as TaskArchiveEntry)]]
            : [],
        ),
      ),
    };
  }

  version() {
    const row = this.open()
      .prepare('SELECT generation,revision FROM archive_sequence WHERE id=0')
      .get()!;
    return { generation: String(row.generation), revision: Number(row.revision) };
  }

  get(id: string): TaskArchiveEntry | undefined {
    const row = this.open().prepare('SELECT full FROM task_archive WHERE id=?').get(id);
    if (typeof row?.full === 'string')
      return withForwardProgress(JSON.parse(row.full) as TaskArchiveEntry);
  }

  subscribe(listener: (change: TaskArchiveChange) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: TaskArchivePatch): TaskArchiveChange | undefined {
    const rows = Object.entries(patch);
    if (!rows.length) return undefined;
    const db = this.open();
    const version = this.transaction(db, () => {
      this.write(db, rows);
      const current = db
        .prepare(
          'UPDATE archive_sequence SET revision=revision+1 WHERE id=0 RETURNING generation,revision',
        )
        .get()!;
      return { generation: String(current.generation), revision: Number(current.revision) };
    });
    const change = {
      ...version,
      patch: Object.fromEntries(
        rows.map(([id, entry]) => [id, entry ? withForwardProgress(summarize(entry)) : null]),
      ),
    };
    for (const listener of this.listeners) listener(change);
    return change;
  }
}

const stores = new Map<string, TaskArchiveStore>();

export function taskArchiveStore(root: string, configId?: string): TaskArchiveStore {
  const path = join(
    root,
    'config',
    ...(configId ? ['accounts', configId] : []),
    'task-archive.json',
  );
  let store = stores.get(path);
  if (!store) {
    store = new TaskArchiveStore(path);
    stores.set(path, store);
  }
  return store;
}

/** 应用级回执由各数据源共用，账号业务回执仍写入原数据源。 */
export class TaskArchiveView {
  private readonly account: TaskArchiveStore;
  private readonly host: TaskArchiveStore;

  constructor(root: string, configId: string) {
    this.account = taskArchiveStore(root, configId);
    this.host = taskArchiveStore(root);
  }

  storeFor(id: string) {
    return id.startsWith('background:host:') && this.host.get(id) ? this.host : this.account;
  }

  get(id: string) {
    return this.storeFor(id).get(id);
  }

  snapshot() {
    return { ...this.account.snapshot(), ...this.host.snapshot() };
  }

  summaries() {
    const account = this.account.summaries();
    const host = this.host.summaries();
    return { ...this.version(account, host), entries: { ...account.entries, ...host.entries } };
  }

  private version(account = this.account.version(), host = this.host.version()) {
    return {
      generation: `${account.generation}:${host.generation}`,
      revision: account.revision + host.revision,
    };
  }

  subscribe(listener: (change: TaskArchiveChange) => void, initial = false) {
    const version = initial ? this.version() : undefined;
    const account = this.account.subscribe((change) =>
      listener({ ...this.version(change), patch: change.patch }),
    );
    const host = this.host.subscribe((change) =>
      listener({ ...this.version(undefined, change), patch: change.patch }),
    );
    if (version) listener(version);
    return () => {
      account();
      host();
    };
  }

  update(patch: TaskArchivePatch) {
    const account: TaskArchivePatch = {};
    const host: TaskArchivePatch = {};
    for (const [id, entry] of Object.entries(patch)) {
      (this.storeFor(id) === this.host ? host : account)[id] = entry;
    }
    const accountChange = this.account.update(account);
    const hostChange = this.host.update(host);
    if (accountChange && !hostChange)
      return { ...this.version(accountChange), patch: accountChange.patch };
    if (hostChange && !accountChange)
      return { ...this.version(undefined, hostChange), patch: hostChange.patch };
    // 混合归档分别写入两个库，订阅逐次更新，其他调用方按最新版本刷新。
    return undefined;
  }
}

export function storedTaskSnapshot(task: BackgroundTask | undefined): BackgroundTask | undefined {
  return (
    task && {
      ...task,
      actions: [],
      // 下载票据和临时窗口标识没有跨重启用途。
      download: undefined,
      ownerId: undefined,
      logs: task.logs?.slice(-200),
      details: task.details?.slice(0, 2000),
    }
  );
}

export function archiveCompletedBackgroundTask(root: string, task: BackgroundTask) {
  if (
    task.status !== 'completed' ||
    task.needsConfirmation ||
    task.subtasks?.some((part) => part.failed) ||
    (task.scope && !task.scope.configId)
  )
    return;
  const id = `background:host:${task.id}`;
  const result = backgroundResult(task);
  try {
    const store = taskArchiveStore(root, task.scope?.configId);
    const previous = store.get(id);
    if (store.busy.has(id) || previous?.result === result) return;
    store.update({
      [id]: {
        result,
        seen: true,
        archivedAt: task.finishedAt ?? Date.now(),
        snapshot: storedTaskSnapshot({ ...task, foreground: false }),
      },
    });
  } catch (error) {
    console.warn('[任务] 自动归档失败', error);
  }
}

/** 已打开产物，保留其业务记录；归档写入失败时仍可在当前任务查看。 */
export function archiveViewedTask(store: TaskArchiveStore, id: string, result: string) {
  try {
    const row = store.get(id);
    if (
      store.busy.has(id) ||
      isTaskArchived(row, result) ||
      (row?.result === result && row.restored)
    )
      return;
    store.update({ [id]: { result, archivedAt: Date.now(), seen: true } });
  } catch {
    // 文件已打开，归档可从任务页重试。
  }
}
