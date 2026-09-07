/**
 * Offline `NtHelperBinding` backed by Node's built-in `node:sqlite`.
 *
 * Unit tests must never touch a real QQ install — but the `@weq/db` accessors
 * (GroupMsgDb / C2cMsgDb / ProfileInfoDb / MsgSearchIndexDb) are all built on
 * the `QqDb` → native `executeSql*` path. This stub implements exactly that
 * subset against **plain (unencrypted) SQLite fixture files**, so the REAL
 * production SQL + decode logic runs unchanged in CI:
 *
 *   import { createSqliteStub } from '@weq/testkit';
 *   const nt = createSqliteStub();
 *   const db = new GroupMsgDb(nt, { dbPath: fixturePath });  // plain: no key
 *
 * Encryption-aware call sites (key + algo set) hit the `*WithKey` variants;
 * the stub routes them to the same plain file — fixture data was never
 * encrypted to begin with. `fastDecryptDatabase` (the bulk-decrypt used by
 * MsgSearchIndexDb) degrades to a plain file copy.
 *
 * Requires Node ≥ 22.5 (`node:sqlite`); the repo CI runs Node 26.
 */

import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { NtHelperBinding, SqlRow, SqlValue } from '@weq/native';

// `node:sqlite` is loaded through createRequire: vite 5's builtin-module list
// predates it and rewrites a static import into an unresolvable bare `sqlite`.
const nodeRequire = createRequire(import.meta.url);
const nodeSqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/** One cached handle per file path, mirroring the native layer's behavior. */
const connections = new Map<string, DatabaseSyncType>();

function conn(path: string): DatabaseSyncType {
  let db = connections.get(path);
  if (!db) {
    db = new nodeSqlite.DatabaseSync(path);
    connections.set(path, db);
  }
  return db;
}

/** Close + forget one path (the stub's `closeDb`); silently ignore unknown ones. */
function dropConn(path: string): void {
  const db = connections.get(path);
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    connections.delete(path);
  }
}

function toParams(params: SqlValue[] | null | undefined): SqlValue[] {
  return params ?? [];
}

function runSelect(path: string, sql: string, params: SqlValue[] | null | undefined): SqlRow[] {
  const stmt = conn(path).prepare(sql);
  stmt.setReadBigInts(true);
  // Positional rows to match the native binding's SqlRow. (The default object
  // mode breaks with QQ's numeric column names: JS orders integer-like keys
  // numerically, which would scramble the SELECT column order.)
  stmt.setReturnArrays(true);
  return stmt.all(...toParams(params)) as unknown as SqlRow[];
}

function runWrite(path: string, sql: string, params: SqlValue[] | null | undefined): number {
  const stmt = conn(path).prepare(sql);
  stmt.setReadBigInts(true);
  stmt.setReturnArrays(true);
  return Number(stmt.run(...toParams(params)).changes);
}

/**
 * A partial `NtHelperBinding` cast to the full type: only the methods the
 * offline-tested classes actually call are implemented. Everything else
 * throws "not implemented by the sqlite stub" so a test silently drifting
 * onto a new native call fails loudly instead of misbehaving.
 */
export function createSqliteStub(): NtHelperBinding {
  const unsupported = (name: string): never => {
    throw new Error(`[sqlite-stub] ${name} is not implemented — this test needs a real nt_helper`);
  };

  // Partial<> gives the object literal contextual typing; the final cast keeps
  // the declared return type (the unimplemented remainder throws at runtime).
  const stub: Partial<NtHelperBinding> = {
    executeSql: async (dbPath, sql, params) => runSelect(dbPath, sql, params),

    executeSqlWithKey: async (dbPath, sql, _key, _algo, params) => runSelect(dbPath, sql, params),

    executeSqlWrite: async (dbPath, sql, params) => runWrite(dbPath, sql, params),

    executeSqlWriteWithKey: async (dbPath, sql, _key, _algo, params) =>
      runWrite(dbPath, sql, params),

    closeDb: (dbPath) => {
      dropConn(dbPath);
      return 1;
    },

    closeAllDb: () => {
      for (const path of [...connections.keys()]) dropConn(path);
      return connections.size;
    },

    fastDecryptDatabase: (dbPath, outPath, _key, _algo) => {
      // The "encrypted" fixture is already plain — a copy IS the decrypt.
      // Checkpoint first: a live WAL-mode source keeps recent commits in
      // `<db>-wal`, and a bare file copy of the main .db would miss them.
      dropConn(outPath);
      try {
        connections.get(dbPath)?.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* not open / not WAL — the main file is already complete */
      }
      copyFileSync(dbPath, outPath);
    },

    // Everything below is native-only surface: fail loudly.
    testDatabaseKey: () => unsupported('testDatabaseKey'),
  };
  return stub as NtHelperBinding;
}

/** Run DDL/DML fixture setup against a plain SQLite file (test-side helper). */
export function fixtureDb(path: string): DatabaseSyncType {
  return conn(path);
}

/** Close every cached fixture handle (call in `afterEach` to free Windows locks). */
export function closeAllFixtureDbs(): void {
  for (const path of [...connections.keys()]) dropConn(path);
}
