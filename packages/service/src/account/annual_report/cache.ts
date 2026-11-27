import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../common/atomic_write';
import type { PageAvailability, ReportPageResult, ReportScope } from './types';

export function scopeKey(scope: ReportScope): string {
  return JSON.stringify(scope);
}

const maxPageBytes = 512 * 1024;
const retainedPages = 48;

export function reportDatabaseRevision(path: string) {
  try {
    const identity = (file: string) => {
      try {
        const info = statSync(file, { bigint: true });
        return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const main = identity(path);
    if (main)
      return JSON.stringify([path, main, identity(`${path}-wal`), identity(`${path}-journal`)]);
  } catch {
    /* 无法识别源库版本时只使用本次运行的内存缓存。 */
  }
}

export class ReportPageFiles {
  constructor(private readonly root: string) {}

  private path(key: string) {
    return join(this.root, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  async read(key: string, pageId: string, version: string) {
    const path = this.path(key);
    try {
      if ((await stat(path)).size > maxPageBytes) return;
      const saved = JSON.parse(await readFile(path, 'utf8')) as ReportPageResult;
      if (
        saved?.pageId === pageId &&
        saved.version === version &&
        (saved.status === 'ok' || saved.status === 'unavailable')
      )
        return saved;
    } catch {
      /* 单页缓存不可用时重新计算。 */
    }
  }

  async save(key: string, result: ReportPageResult) {
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > maxPageBytes) return;
    await writeFileAtomic(this.path(key), json);
    const files = (await readdir(this.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (files.length <= retainedPages) return;
    const stamps = await Promise.all(
      files.map(async (name) => {
        const path = join(this.root, name);
        return { path, time: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0 };
      }),
    );
    await Promise.all(
      stamps
        .sort((a, b) => b.time - a.time)
        .slice(retainedPages)
        .map(({ path }) => rm(path, { force: true })),
    );
  }
}

export class AnnualReportCache {
  private readonly pages = new Map<string, ReportPageResult>();
  private readonly inFlight = new Map<string, Promise<ReportPageResult>>();
  private readonly availability = new Map<string, Promise<PageAvailability>>();

  getPage(key: string): ReportPageResult | undefined {
    return this.pages.get(key);
  }

  setPage(key: string, value: ReportPageResult): void {
    this.pages.set(key, value);
  }

  getInFlight(key: string): Promise<ReportPageResult> | undefined {
    return this.inFlight.get(key);
  }

  setInFlight(key: string, value: Promise<ReportPageResult>): void {
    this.inFlight.set(key, value);
  }

  deleteInFlight(key: string): void {
    this.inFlight.delete(key);
  }

  getAvailability(key: string): Promise<PageAvailability> | undefined {
    return this.availability.get(key);
  }

  setAvailability(key: string, value: Promise<PageAvailability>): void {
    this.availability.set(key, value);
  }

  deleteAvailability(key: string): void {
    this.availability.delete(key);
  }

  clear(): void {
    this.pages.clear();
    this.inFlight.clear();
    this.availability.clear();
  }
}
