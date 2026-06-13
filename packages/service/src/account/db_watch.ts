/**
 * DbWatchService — ONE polling loop that watches QQ databases for *size*
 * changes and runs a per-db hook when one changes.
 *
 * Why a single shared loop with mount/unmount instead of one watcher per
 * db: the machine has lots of databases, but only a handful are ever
 * interesting at a time (e.g. the currently-open account's `nt_msg.db`).
 * Callers `mount({ dbPath, onDbFileChangeHook })` the ones they care about
 * and `unmount()` when they stop; the loop only ticks while a watch is live.
 *
 * Separation of concerns: this service detects *that* files changed; it does
 * NOT know what a "message" is. The mounted task's hook owns the "what
 * changed" query (new rows, recalls, upload-complete state, ...) and routes
 * the result onward. See `createNtMsgDbHook` for the nt_msg.db task.
 *
 * "Size" deliberately means the SUM of every sibling file whose name starts
 * with the db's filename — so `nt_msg.db`, `nt_msg.db-wal`, `nt_msg.db-shm`,
 * `nt_msg.db-journal`, ... all roll up into one logical "this database
 * changed" signal. (SQLite in WAL mode writes to `-wal`/`-shm` first and
 * only periodically checkpoints back into the main file, so watching the
 * `.db` alone would miss most activity.)
 *
 * Unlike the other `account/` services this one is NOT bound to an
 * `AccountSession` — it works purely off filesystem paths and is meant to
 * live as a process-wide singleton (mount the active account's db on
 * `setAccount`, unmount on `clearAccount`). It performs no decryption,
 * opens no db handles, and never reads file *contents* — only `stat` sizes.
 */

import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const DEFAULT_INTERVAL_MS = 1_000;

export interface DbWatchOptions {
  /** Poll interval in ms. Default 1000. */
  intervalMs?: number;
}

export interface DbFileSize {
  /** File name relative to the database's directory. */
  name: string;
  /** Size in bytes. */
  size: number;
}

export interface DbChange {
  /** Absolute, resolved path of the watched database (the `.db` file). */
  dbPath: string;
  /** Summed size of all sibling files at the previous tick. */
  prevTotal: number;
  /** Summed size of all sibling files now. */
  total: number;
  /** `total - prevTotal`. Negative on shrink (e.g. a WAL checkpoint). */
  delta: number;
  /** Per-file breakdown contributing to `total`. */
  files: DbFileSize[];
  /** Epoch ms when the change was observed. */
  at: number;
}

/**
 * The hook a watch task runs when its database's files change size. It is
 * the task's job to figure out *what* changed (query new/edited rows) and
 * route that out — the watcher itself stays oblivious to message semantics.
 * May be async; the watcher serializes invocations of the same task (never
 * runs a task's hook concurrently with itself).
 */
export type DbChangeHook = (change: DbChange) => void | Promise<void>;

/**
 * One thing to watch: a database path plus the hook to run on change.
 * Callers build these (e.g. `createNtMsgDbHook`) and `mount` them.
 */
export interface DbWatchTask {
  /** Path to the database's main file (e.g. `nt_msg.db`). */
  dbPath: string;
  /** Runs whenever the rolled-up size of `dbPath`'s sibling files changes. */
  onDbFileChangeHook: DbChangeHook;
}

/** Returned by `mount`. Call `unmount()` to stop watching. */
export interface DbWatchHandle {
  /** Idempotent: drops this task; stops the loop if it was the last. */
  unmount(): void;
}

interface WatchEntry {
  readonly dbPath: string;
  readonly task: DbWatchTask;
  /** Last size we acted on. Only advances when we actually fire the hook. */
  lastTotal: number;
  /** A change was seen but the hook hasn't consumed it yet (trailing edge). */
  dirty: boolean;
  /** The hook is mid-flight — don't start a second copy. */
  running: boolean;
}

export class DbWatchService {
  private readonly intervalMs: number;
  private readonly entries = new Set<WatchEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DbWatchOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Start watching `task.dbPath`. The hook fires only on *subsequent* size
   * changes — the size at mount time is the baseline and never fires, so a
   * fresh mount doesn't spuriously report "changed".
   *
   * Each `mount` is an independent task (mount the same path twice and both
   * hooks run). The returned handle's `unmount()` removes just this task.
   */
  mount(task: DbWatchTask): DbWatchHandle {
    const dbPath = resolve(task.dbPath);
    const entry: WatchEntry = {
      dbPath,
      task,
      lastTotal: aggregate(dbPath).total,
      dirty: false,
      running: false,
    };
    this.entries.add(entry);
    this.ensureLoop();

    let unmounted = false;
    return {
      unmount: (): void => {
        if (unmounted) return;
        unmounted = true;
        this.entries.delete(entry);
        if (this.entries.size === 0) this.stopLoop();
      },
    };
  }

  /** Run one poll pass immediately, on top of the loop. Mainly for tests. */
  pollNow(): void {
    this.tick();
  }

  /** Stop the loop and forget every watch. Idempotent. */
  dispose(): void {
    this.stopLoop();
    this.entries.clear();
  }

  // ---- internals ----

  private ensureLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Don't keep the process alive just for the watcher.
    this.timer.unref();
  }

  private stopLoop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const at = Date.now();
    for (const entry of this.entries) {
      const { total, files } = aggregate(entry.dbPath);
      if (total !== entry.lastTotal) entry.dirty = true;
      // Skip if nothing new, or the previous hook run hasn't finished — its
      // trailing-edge re-check (driven by `dirty`) will catch what it missed.
      if (!entry.dirty || entry.running) continue;

      const prevTotal = entry.lastTotal;
      entry.lastTotal = total;
      entry.dirty = false;
      entry.running = true;

      const change: DbChange = {
        dbPath: entry.dbPath,
        prevTotal,
        total,
        delta: total - prevTotal,
        files,
        at,
      };
      // Fire-and-forget, but serialized per task via `running`. Hooks must
      // recompute their own delta (msgId diff, etc.) rather than trusting
      // `change.delta` to be exact — coalesced ticks fold multiple changes.
      Promise.resolve()
        .then(() => entry.task.onDbFileChangeHook(change))
        .catch(() => {
          /* a misbehaving hook must not break the loop or its peers */
        })
        .finally(() => {
          entry.running = false;
        });
    }
  }
}

/**
 * Sum the sizes of every file in `dbPath`'s directory whose name starts
 * with the db's basename. Missing dir / files are treated as size 0 — a db
 * that legitimately vanished reports `total = 0`, which is itself a change
 * worth surfacing.
 *
 * The `startsWith` match is intentionally broad ("any suffix counts"): it
 * catches the `-wal`/`-shm`/`-journal` family without hard-coding them. The
 * only practical false-positive would be an unrelated file that happens to
 * share the full `nt_msg.db` prefix in the same folder — QQ doesn't create
 * such files, so this is fine in practice.
 */
function aggregate(dbPath: string): { total: number; files: DbFileSize[] } {
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { total: 0, files: [] };
  }
  const files: DbFileSize[] = [];
  let total = 0;
  for (const name of names) {
    if (!name.startsWith(base)) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      files.push({ name, size: st.size });
      total += st.size;
    } catch {
      /* file disappeared between readdir and stat — skip it */
    }
  }
  return { total, files };
}
