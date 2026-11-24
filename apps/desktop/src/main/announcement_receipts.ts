import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod/v3';
import { ANNOUNCEMENT_ID } from '@weq/network/announcement-metadata';
import { writeFileAtomic } from '@weq/service/atomic-write';

const requireFromHere = createRequire(import.meta.url);
const receiptsSchema = z.object({
  read: z.array(z.string().regex(ANNOUNCEMENT_ID)),
  reminded: z.array(z.string().regex(ANNOUNCEMENT_ID)),
});
type Receipts = z.infer<typeof receiptsSchema>;

async function readLegacyReceipt(path: string) {
  const json = await readFile(path, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (json === null) return;
  try {
    const result = receiptsSchema.safeParse(JSON.parse(json));
    if (result.success) return result.data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

async function legacyReceipts(dataRoot: string, sharedDataRoot: string) {
  const roots = new Set([dataRoot, sharedDataRoot]);
  const instances = join(sharedDataRoot, 'instances');
  const entries = await readdir(instances, { withFileTypes: true }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f\d]{24}$/.test(entry.name)) continue;
    roots.add(join(instances, entry.name, 'data'));
    roots.add(join(instances, entry.name, 'electron'));
  }
  return Promise.all(
    [...roots].map((root) => readLegacyReceipt(join(root, 'announcements', 'receipts.json'))),
  );
}

export interface AnnouncementReceipts {
  get(id: string): { read: boolean; reminded: boolean };
  markRead(ids: readonly string[], feedIds: readonly string[]): boolean | Promise<boolean>;
  claimBanner(id: string, now: number, expiresAt: number): string | null;
  finishBanner(
    token: string,
    shown: boolean,
    feedIds: readonly string[],
  ): boolean | Promise<boolean>;
  pollChanged?(): boolean;
  close?(): void;
}

export async function openAnnouncementReceipts(
  dataRoot: string,
  sharedDataRoot?: string,
): Promise<AnnouncementReceipts> {
  if (sharedDataRoot) return SharedAnnouncementReceipts.open(dataRoot, sharedDataRoot);
  return LocalAnnouncementReceipts.open(dataRoot);
}

// 独立 Web 服务只有一个进程，保留 JSON 回执及现有 Node 版本支持。
class LocalAnnouncementReceipts implements AnnouncementReceipts {
  static async open(dataRoot: string) {
    const path = join(dataRoot, 'announcements', 'receipts.json');
    const receipts = await readLegacyReceipt(path).catch(() => undefined);
    return new LocalAnnouncementReceipts(path, receipts ?? { read: [], reminded: [] });
  }

  private lease?: { id: string; token: string; expiresAt: number };

  private constructor(
    private readonly path: string,
    private receipts: Receipts,
  ) {}

  get(id: string) {
    return { read: this.receipts.read.includes(id), reminded: this.receipts.reminded.includes(id) };
  }

  private async save(receipts: Receipts, feedIds: readonly string[]) {
    const ids = new Set(feedIds);
    const next = {
      read: receipts.read.filter((id) => ids.has(id)),
      reminded: receipts.reminded.filter((id) => ids.has(id)),
    };
    await writeFileAtomic(this.path, JSON.stringify(next));
    this.receipts = next;
  }

  async markRead(ids: readonly string[], feedIds: readonly string[]) {
    const unread = ids.filter((id) => !this.receipts.read.includes(id));
    if (!unread.length) return false;
    await this.save({ ...this.receipts, read: [...this.receipts.read, ...unread] }, feedIds);
    return true;
  }

  claimBanner(id: string, now: number, expiresAt: number) {
    const receipt = this.get(id);
    if ((this.lease && this.lease.expiresAt > now) || receipt.read || receipt.reminded) return null;
    const token = randomUUID();
    this.lease = { id, token, expiresAt };
    return token;
  }

  async finishBanner(token: string, shown: boolean, feedIds: readonly string[]) {
    const lease = this.lease;
    if (lease?.token !== token) return false;
    this.lease = undefined;
    if (!shown) return false;
    await this.save({ ...this.receipts, reminded: [...this.receipts.reminded, lease.id] }, feedIds);
    return true;
  }
}

class SharedAnnouncementReceipts implements AnnouncementReceipts {
  static async open(dataRoot: string, sharedDataRoot: string) {
    const directory = join(sharedDataRoot, 'announcements');
    await mkdir(directory, { recursive: true });
    // Vite 5 不识别 node:sqlite 内置模块，交给 Electron/Node 运行时加载。
    const { DatabaseSync } = requireFromHere('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(directory, 'receipts.sqlite'));
    try {
      db.exec(`
        PRAGMA busy_timeout = 500;
        CREATE TABLE IF NOT EXISTS receipt (
          id TEXT PRIMARY KEY, read INTEGER NOT NULL DEFAULT 0, reminded INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS banner_lease (
          slot INTEGER PRIMARY KEY CHECK (slot = 1), id TEXT NOT NULL,
          token TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
      `);
      const store = new SharedAnnouncementReceipts(db);
      if (!db.prepare('PRAGMA user_version').get()?.user_version) {
        const legacy = await legacyReceipts(dataRoot, sharedDataRoot);
        store.transaction(() => {
          for (const receipt of legacy) {
            if (!receipt) continue;
            for (const id of receipt.read) store.setRead.run(id);
            for (const id of receipt.reminded) store.setReminded.run(id);
          }
          db.exec('PRAGMA user_version = 1');
        });
      }
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private readonly getReceipt: StatementSync;
  private readonly setRead: StatementSync;
  private readonly setReminded: StatementSync;
  private readonly dataVersion: StatementSync;
  private observedVersion;

  private constructor(private readonly db: DatabaseSync) {
    this.getReceipt = db.prepare('SELECT read, reminded FROM receipt WHERE id = ?');
    this.setRead = db.prepare(`
      INSERT INTO receipt (id, read) VALUES (?, 1)
      ON CONFLICT(id) DO UPDATE SET read = 1 WHERE read = 0
    `);
    this.setReminded = db.prepare(`
      INSERT INTO receipt (id, reminded) VALUES (?, 1)
      ON CONFLICT(id) DO UPDATE SET reminded = 1 WHERE reminded = 0
    `);
    this.dataVersion = db.prepare('PRAGMA data_version');
    this.observedVersion = this.version();
  }

  private version() {
    return Number(this.dataVersion.get()?.data_version);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  pollChanged() {
    const version = this.version();
    const changed = version !== this.observedVersion;
    this.observedVersion = version;
    return changed;
  }

  get(id: string) {
    const receipt = this.getReceipt.get(id);
    return { read: receipt?.read === 1, reminded: receipt?.reminded === 1 };
  }

  markRead(ids: readonly string[]) {
    return this.transaction(() => {
      let changed = false;
      for (const id of ids) {
        if (this.setRead.run(id).changes) changed = true;
      }
      return changed;
    });
  }

  claimBanner(id: string, now: number, expiresAt: number) {
    return this.transaction(() => {
      const receipt = this.get(id);
      if (receipt.read || receipt.reminded) return null;
      const token = randomUUID();
      const result = this.db
        .prepare(`
        INSERT INTO banner_lease (slot, id, token, expires_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET
          id = excluded.id, token = excluded.token, expires_at = excluded.expires_at
        WHERE banner_lease.expires_at <= ?
      `)
        .run(id, token, expiresAt, now);
      return result.changes ? token : null;
    });
  }

  finishBanner(token: string, shown: boolean) {
    return this.transaction(() => {
      const pending = this.db
        .prepare('DELETE FROM banner_lease WHERE token = ? RETURNING id')
        .get(token);
      return (
        shown &&
        typeof pending?.id === 'string' &&
        Boolean(this.setReminded.run(pending.id).changes)
      );
    });
  }
}
