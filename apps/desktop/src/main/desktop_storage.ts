import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const storageSqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export class DesktopStorage {
  private readonly lease: DatabaseSync;
  private shared = false;

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.lease = this.open('desktop-storage.sqlite');
    try {
      this.acquireShared();
    } catch (error) {
      this.lease.close();
      throw error;
    }
  }

  private open(name: string): DatabaseSync {
    const db = new storageSqlite.DatabaseSync(join(this.root, name));
    db.exec('PRAGMA busy_timeout = 400');
    return db;
  }

  private acquireShared(): void {
    this.lease.exec('BEGIN; SELECT name FROM sqlite_schema');
    this.shared = true;
  }

  private acquireExclusive(): () => void {
    const gate = this.open('desktop-storage-maintenance.sqlite');
    try {
      gate.exec('BEGIN IMMEDIATE');
      this.lease.exec('ROLLBACK');
      this.shared = false;
      try {
        this.lease.exec('BEGIN EXCLUSIVE');
      } catch (error) {
        this.acquireShared();
        throw error;
      }
    } catch (error) {
      gate.close();
      if ((error as { errcode?: number }).errcode === 5)
        throw new Error('其他 WeQ 窗口正在使用共享数据，请关闭后重试。', { cause: error });
      throw error;
    }
    return () => {
      try {
        this.lease.exec('ROLLBACK');
        this.acquireShared();
      } finally {
        gate.close();
      }
    };
  }

  initialize<T>(operation: () => T): T {
    const release = this.acquireExclusive();
    try {
      return operation();
    } finally {
      release();
    }
  }

  async maintain<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.acquireExclusive();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  close(): void {
    if (this.shared) this.lease.exec('ROLLBACK');
    this.lease.close();
  }
}

let storage: DesktopStorage | undefined;

export function setDesktopStorage(value: DesktopStorage): void {
  storage = value;
}

export function maintainDesktopStorage<T>(operation: () => Promise<T>): Promise<T> {
  return storage ? storage.maintain(operation) : operation();
}
