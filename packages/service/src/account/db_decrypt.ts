/**
 * Database decrypt service for the current QQ account.
 *
 * Lists encrypted `*.db` files from the account's `nt_qq/nt_db` directory and
 * exports selected databases through the native bulk decrypt helpers.
 */

import { mkdirSync } from 'node:fs';
import { copyFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { type AccountSession, algoFor } from '@weq/account';
import type { DatabaseAlgorithms, NtHelperBinding } from '@weq/native';
import type { Platform } from '@weq/platform';

export type DbDecryptMode = 'fast' | 'safe';

/**
 * login.db（`nt_qq/global/nt_db/login.db`）的固定 SQLCipher 密钥。
 * 它是全局数据库，不属于任何账号，密钥也是固定的；需要解密 / 查看 / 修改时
 * 走通用的 SQLCipher 路径（testDatabaseKey + fast/safeDecryptDatabase 或
 * executeSqlWithKey），不要走 native 专门为 login.db 设计的 decryptLoginDb
 * 接口（那个只吐 LoginAccount 行，改不了内容）。
 */
export const LOGIN_DB_KEY = 'BD156D6710D54D8782F4';

/** True when `dbPath` points at the global `login.db`. */
export function isLoginDb(dbPath: string): boolean {
  return basename(dbPath).toLowerCase() === 'login.db';
}

/**
 * `bc_09.db` 是纯 SQLite（未加密），不走 SQLCipher：无密钥，解密就是直接拷贝。
 */
export function isPlainSqliteDb(dbPath: string): boolean {
  return basename(dbPath).toLowerCase() === 'bc_09.db';
}

export interface AccountDbFile {
  name: string;
  path: string;
  bytes: number;
  /** 'login' 表示全局 login.db（独立固定密钥），否则为账号目录下的库。 */
  kind: 'account' | 'login';
}

export interface DbDecryptItem {
  dbPath: string;
  name?: string;
}

export interface DbDecryptResult {
  name: string;
  dbPath: string;
  outPath: string;
  ok: boolean;
  error?: string;
}

export interface DbDecryptOptions {
  items: DbDecryptItem[];
  outputDir: string;
  mode: DbDecryptMode;
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 6;

export class DbDecryptService {
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  listDatabases(): Promise<AccountDbFile[]> {
    const dir = this.resolveNtDbDir();
    if (!dir) return Promise.resolve([]);
    return listDbFiles(dir).then(async (files) => {
      const login = await this.loginDbFile();
      return login ? [...files, login] : files;
    });
  }

  /** The global `login.db`（固定密钥 {@link LOGIN_DB_KEY}），不存在时为 null。 */
  async loginDbFile(): Promise<AccountDbFile | null> {
    const path = this.platform.loginDbPath();
    if (!path) return null;
    try {
      const st = await stat(path);
      if (!st.isFile()) return null;
      return { name: 'login.db', path, bytes: st.size, kind: 'login' };
    } catch {
      return null;
    }
  }

  isQqLoggedIn(): boolean {
    // Platform wraps the per-OS probe inputs (linux needs baseDir + uid).
    return this.platform.isQqLoggedIn(this.session.context.uin);
  }

  async decryptDatabases(opts: DbDecryptOptions): Promise<DbDecryptResult[]> {
    if (opts.items.length === 0) return [];
    mkdirSync(opts.outputDir, { recursive: true });
    const concurrency = Math.min(
      MAX_CONCURRENCY,
      Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY)),
    );

    const allowed = new Map((await this.listDatabases()).map((db) => [db.path, db]));
    const items = opts.items.map((item) => {
      const db = allowed.get(item.dbPath);
      if (!db) throw new Error(`数据库不在当前账号目录下：${item.dbPath}`);
      return { dbPath: db.path, name: item.name || db.name };
    });

    const ntHelperPath = join(dirname(this.platform.native.resources.loaderDir), 'nt_helper.node');
    return mapLimit(items, concurrency, async (item) => {
      const outPath = outputPath(opts.outputDir, item.name, item.dbPath);
      try {
        if (isPlainSqliteDb(item.dbPath)) {
          await copyFile(item.dbPath, outPath);
          return { name: item.name, dbPath: item.dbPath, outPath, ok: true };
        }
        const guild = isGuildDb(item.dbPath);
        const login = isLoginDb(item.dbPath);
        const key = guild
          ? this.platform.native.ntHelper.getGuildDbKey(item.dbPath, this.session.context.uin)
          : login
            ? LOGIN_DB_KEY
            : this.session.context.dbKey;
        const algo =
          guild || login
            ? await resolveAlgo(this.platform.native.ntHelper, item.dbPath, key)
            : algoFor(this.session.context, item.dbPath);
        if (login && !algo) throw new Error('login.db 密钥不正确，无法解密');
        await decryptOneInWorker(ntHelperPath, item.dbPath, outPath, key, algo, opts.mode);
        return { name: item.name, dbPath: item.dbPath, outPath, ok: true };
      } catch (e) {
        return {
          name: item.name,
          dbPath: item.dbPath,
          outPath,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    });
  }

  private resolveNtDbDir(): string | null {
    return this.platform.ntDbDir(this.session.context.uin);
  }
}

async function listDbFiles(dir: string): Promise<AccountDbFile[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: AccountDbFile[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.db')) return;
      const path = join(dir, entry.name);
      try {
        const st = await stat(path);
        if (st.isFile()) files.push({ name: entry.name, path, bytes: st.size, kind: 'account' });
      } catch {
        /* skip unreadable files */
      }
    }),
  );
  files.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return files;
}

function decryptOneInWorker(
  ntHelperPath: string,
  dbPath: string,
  outPath: string,
  key: string,
  algo: DatabaseAlgorithms | undefined,
  mode: DbDecryptMode,
): Promise<void> {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    try {
      const nt = require(workerData.ntHelperPath);
      if (typeof nt.getInitStatus === 'function' && nt.getInitStatus() !== 0) {
        throw new Error('nt_helper initialization failed in decrypt worker');
      }
      const method = workerData.mode === 'fast' ? 'fastDecryptDatabase' : 'safeDecryptDatabase';
      nt[method](workerData.dbPath, workerData.outPath, workerData.key, workerData.algo);
      parentPort.postMessage({ ok: true });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  `;

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const worker = new Worker(code, {
      eval: true,
      workerData: { ntHelperPath, dbPath, outPath, key, algo, mode },
    });
    worker.once('message', (msg: { ok?: boolean; error?: string }) => {
      if (msg?.ok) settle(resolvePromise);
      else settle(() => reject(new Error(msg?.error || 'decrypt worker failed')));
    });
    worker.once('error', (err) => settle(() => reject(err)));
    worker.once('exit', (code) => {
      if (code !== 0) settle(() => reject(new Error(`decrypt worker exited with code ${code}`)));
    });
  });
}

function outputPath(outputDir: string, nameOrPath: string, sourcePath: string): string {
  const direct = join(outputDir, outputName(nameOrPath));
  if (resolve(direct).toLowerCase() !== resolve(sourcePath).toLowerCase()) return direct;

  const name = basename(nameOrPath);
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return join(outputDir, `${stem}.decrypted.db`);
}

function outputName(nameOrPath: string): string {
  const name = basename(nameOrPath);
  return name.toLowerCase().endsWith('.db') ? name : `${name}.db`;
}

function isGuildDb(dbPath: string): boolean {
  return basename(dbPath).startsWith('gpro_');
}

async function resolveAlgo(
  nt: NtHelperBinding,
  dbPath: string,
  key: string,
): Promise<DatabaseAlgorithms | undefined> {
  const probe = await nt.testDatabaseKey(dbPath, key);
  if (probe.success && probe.pageHmacAlgorithm && probe.kdfHmacAlgorithm) {
    return { pageHmacAlgorithm: probe.pageHmacAlgorithm, kdfHmacAlgorithm: probe.kdfHmacAlgorithm };
  }
  return undefined;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) break;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
