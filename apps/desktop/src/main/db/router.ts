/**
 * Split the native SQL surface across two processes.
 *
 * Why: SQLite's pager pending byte is a process-global, and QQ's 1024-byte
 * wrapper moves the reserved page from 262145 to 262144.  A single process
 * cannot safely serve both layouts, so:
 *
 *   - keyed (`*WithKey`) calls stay here, in the main process, initialized `qq`
 *     — SQLCipher is the hot path and must not pay IPC;
 *   - plain calls go to `standardDbWorker`, initialized `standard`;
 *   - close / quarantine bookkeeping is sent to both lanes.
 *
 * Everything else (memory scanning, signing, protobuf, font conversion) is
 * forwarded to the real addon untouched.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveNtHelperPath, type NtHelperBinding } from '@weq/native';
import { dbLaneFor } from './lane';
import type { StandardDbMethod } from './protocol';
import { StandardDbClient } from './standard_client';

/** The part of {@link StandardDbClient} the router needs (fakeable in tests). */
export interface StandardDbLane {
  request<T>(method: StandardDbMethod, args: unknown[]): Promise<T>;
  notify(method: StandardDbMethod, args: unknown[]): void;
  dispose(): void;
}

let defaultClient: StandardDbClient | undefined;

/**
 * Sidecar written next to a decrypted QQ database.  The plaintext copy keeps
 * QQ's page numbering, so it must be opened by a QQ-layout process even though
 * it has no encryption key.  The marker survives restarts (the search index is
 * a persistent cache and is not rebuilt every launch).
 */
const QQ_LAYOUT_SUFFIX = '.weq-qq-layout';
const qqLayoutPaths = new Set<string>();

function isQqLayoutPath(dbPath: unknown): boolean {
  if (typeof dbPath !== 'string' || dbPath === '') return false;
  const key = resolve(dbPath);
  if (qqLayoutPaths.has(key)) return true;
  if (!existsSync(key + QQ_LAYOUT_SUFFIX)) return false;
  qqLayoutPaths.add(key);
  return true;
}

function markQqLayoutPath(dbPath: string): void {
  const key = resolve(dbPath);
  qqLayoutPaths.add(key);
  try {
    writeFileSync(key + QQ_LAYOUT_SUFFIX, '');
  } catch {
    // Read-only directory: the in-memory marker still covers this session.
  }
}

/**
 * Wrap `nt` so DB calls land in the right process.  Also fixes the main
 * process to the QQ layout before the first database can be opened.
 */
export function createDbRouter(nt: NtHelperBinding, standard?: StandardDbLane): NtHelperBinding {
  let client: StandardDbLane;
  if (standard) {
    client = standard;
  } else {
    defaultClient ??= new StandardDbClient(resolveNtHelperPath());
    client = defaultClient;
  }

  if (typeof nt.setDbLayout === 'function') {
    try {
      nt.setDbLayout('qq');
    } catch (error) {
      throw new Error(
        `初始化 QQ 数据库布局失败：${error instanceof Error ? error.message : String(error)}。` +
          '这通常意味着 nt_helper 原生产物过旧或损坏，请重新获取对应平台的产物。',
      );
    }
  } else {
    console.warn(
      '[db-router] nt_helper.node 缺少 setDbLayout；QQ 的 1GiB 以上数据库仍可能被误判为损坏',
    );
  }

  return new Proxy(nt, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      const value = Reflect.get(target, prop, receiver);
      const lane = dbLaneFor(prop);

      if (prop === 'markQqLayout') {
        return (dbPath: string) => markQqLayoutPath(dbPath);
      }

      if (lane === 'standard') {
        // Old artifacts may lack salvage methods; return undefined so the
        // existing capability checks still see the gap instead of getting a
        // generic worker error later.
        if (typeof value !== 'function') return undefined;
        return (...args: unknown[]) => {
          // Decrypted QQ databases are plaintext but keep QQ page numbering;
          // they belong to the main (qq) lane, not the standard worker.
          if (isQqLayoutPath(args[0])) return value.apply(target, args);
          return client.request(prop as StandardDbMethod, args);
        };
      }

      if (prop === 'closeDb' || prop === 'closeSalvageDb') {
        if (typeof value !== 'function') return undefined;
        return (dbPath: string) => {
          client.notify(prop as StandardDbMethod, [dbPath]);
          return typeof value === 'function' ? value.call(target, dbPath) : 0;
        };
      }

      if (prop === 'closeAllDb') {
        if (typeof value !== 'function') return undefined;
        return () => {
          client.notify('closeAllDb', []);
          return typeof value === 'function' ? value.call(target) : 0;
        };
      }

      if (prop === 'clearQuarantinedTables') {
        if (typeof value !== 'function') return undefined;
        return (dbPath?: string | null, table?: string | null) => {
          client.notify('clearQuarantinedTables', [dbPath ?? null, table ?? null]);
          return typeof value === 'function' ? value.call(target, dbPath, table) : 0;
        };
      }

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Stop the standard-SQLite child on app quit (best-effort). */
export function disposeStandardDbWorker(): void {
  defaultClient?.dispose();
  defaultClient = undefined;
}
