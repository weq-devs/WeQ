import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { JsonStore } from '@weq/service';
import { z } from 'zod/v3';

const time = z.number().int().safe().positive().nullable();
const entries = z.record(
  z.string().regex(/^[1-9]\d*$/),
  z.object({ time, mine: time, version: z.string(), checkedAt: z.number() }),
);
type Entry = z.infer<typeof entries>[string];
type Times = Pick<Entry, 'time' | 'mine'>;
type Seed = { time: number; mine?: number };

const BATCH_SIZE = 12;
const OPAQUE_CHANGE_INTERVAL = 10_000;

/** 主库与 WAL 决定消息版本，SHM 也会被只读客户端改动。 */
async function messageSourceVersion(path: string): Promise<string> {
  const files = await Promise.all(
    ['', '-wal', '-journal'].map(async (suffix) => {
      try {
        const info = await stat(path + suffix, { bigint: true });
        return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join('/');
      } catch (error) {
        if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    }),
  );
  return files.join('|');
}

/** 按群保存确认值与空结果。每次目录请求最多推进一批，已有值可直接排序。 */
export class GroupDirectoryTimeCache {
  private readonly store: JsonStore<Record<string, Entry>>;
  private version: string = randomUUID();
  private checkVersion = true;
  private inflight?: Promise<void>;
  private readonly primed = new Set<string>();
  private readonly priority = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private readonly seeds: Record<string, Seed> = {};
  private dirty = false;

  constructor(
    path: string,
    private readonly sourcePath: string | undefined,
    private readonly readRecent: (codes: readonly string[]) => Promise<Record<string, Seed>>,
    private readonly readGroup: (code: string) => Promise<Times>,
    private readonly signal: AbortSignal,
  ) {
    this.store = new JsonStore(path, () => ({}), { normalize: (value) => entries.parse(value) });
  }

  invalidate() {
    this.checkVersion = true;
  }

  prioritize(codes: readonly string[]) {
    for (const code of codes) {
      if (!this.store.data[code] && !this.seeds[code]) continue;
      this.priority.add(code);
      this.retryAt.delete(code);
    }
  }

  flush() {
    if (!this.dirty) return;
    this.store.save();
    this.dirty = false;
  }

  private queue(codes: readonly string[]) {
    const now = Date.now();
    return codes
      .filter((code) => {
        if ((this.retryAt.get(code) ?? 0) > now) return false;
        if (this.priority.has(code)) return true;
        const row = this.store.data[code];
        return (
          !row || (row.version !== this.version && now - row.checkedAt >= OPAQUE_CHANGE_INTERVAL)
        );
      })
      .sort((a, b) => {
        const urgent = Number(this.priority.has(b)) - Number(this.priority.has(a));
        return (
          urgent || (this.store.data[a]?.checkedAt ?? 0) - (this.store.data[b]?.checkedAt ?? 0)
        );
      });
  }

  async read(codes: readonly string[]) {
    this.signal.throwIfAborted();
    const missing = codes.filter((code) => !this.store.data[code] && !this.primed.has(code));
    if (missing.length && !codes.some((code) => this.store.data[code])) {
      for (const code of missing) this.primed.add(code);
      // 静态导入可能没有最近会话表，仍可直接查询对应群。
      const seeds = await this.readRecent(missing).catch(() => ({}));
      this.signal.throwIfAborted();
      Object.assign(this.seeds, seeds);
    }
    const done = !codes.length || (!this.checkVersion && !this.queue(codes).length);
    if (!done && !this.inflight) {
      this.inflight = this.advance(codes).finally(() => {
        this.inflight = undefined;
      });
    }
    const rows: Record<string, { time?: number | null; mine?: number | null }> =
      Object.create(null);
    const failed: string[] = [];
    const now = Date.now();
    for (const code of codes) {
      const saved = this.store.data[code];
      if (saved) rows[code] = { time: saved.time, mine: saved.mine };
      else if (this.seeds[code]) rows[code] = this.seeds[code];
      if ((this.retryAt.get(code) ?? 0) > now) failed.push(code);
    }
    return { rows, done, failed };
  }

  private async advance(codes: readonly string[]) {
    if (this.checkVersion) {
      this.checkVersion = false;
      this.version = this.sourcePath
        ? await messageSourceVersion(this.sourcePath).catch(() => randomUUID())
        : randomUUID();
    }
    const version = this.version;
    for (const code of this.queue(codes).slice(0, BATCH_SIZE)) {
      if (this.signal.aborted) break;
      const urgent = this.priority.delete(code);
      try {
        const row = await this.readGroup(code);
        if (this.signal.aborted) break;
        this.store.data[code] = { ...row, version, checkedAt: Date.now() };
        delete this.seeds[code];
        this.retryAt.delete(code);
        this.dirty = true;
      } catch {
        if (this.signal.aborted) break;
        if (urgent) this.priority.add(code);
        this.retryAt.set(code, Date.now() + 5_000);
      }
    }
    if (!this.signal.aborted) this.flush();
  }
}
