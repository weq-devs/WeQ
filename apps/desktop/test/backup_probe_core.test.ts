// @vitest-environment node
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { NtHelperBinding } from '@weq/native';
import { inspectBackupDatabases, isPlainBackupDatabase } from '../src/main/backup_probe_core';

// `node:sqlite` 走 createRequire：vite 5 的内置模块表早于它，静态 import 会被
// 改写成解析不了的裸 `sqlite`。这里只用来造明文夹具。
const nodeSqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const roots: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-probe-core-'));
  roots.push(dir);
  return dir;
}
const openDbs: InstanceType<typeof nodeSqlite.DatabaseSync>[] = [];
function fixtureDb(path: string) {
  const db = new nodeSqlite.DatabaseSync(path);
  openDbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('带 QQ 包装头和 WAL 的加密备份不进入任何无密钥原生查询', async () => {
  const dir = fixture();
  const header = Buffer.alloc(1100);
  header.write('QQ_NT DB', 32);
  for (const name of ['nt_msg.db', 'profile_info.db']) {
    writeFileSync(join(dir, name), header);
    writeFileSync(join(dir, `${name}-wal`), Buffer.alloc(32));
  }
  const query = vi.fn(() => {
    throw new Error('不应到达的原生入口');
  });
  const nt = { executeSql: query, testDatabaseKey: query } as unknown as NtHelperBinding;
  expect(await inspectBackupDatabases(nt, { dirPath: dir })).toEqual({ status: 'needKey' });
  expect(query).not.toHaveBeenCalled();
});
it.each([0, 1024])('只承认偏移 %i 的完整 SQLite 标识，短头或错误格式不能放行', async (offset) => {
  const file = join(fixture(), 'db');
  const header = Buffer.alloc(offset + 16);
  header.write('SQLite format 3\0', offset);
  writeFileSync(file, header);
  expect(await isPlainBackupDatabase(file)).toBe(true);
  writeFileSync(file, header.subarray(0, header.length - 1));
  expect(await isPlainBackupDatabase(file)).toBe(false);
});
it('资料库明文但消息库加密仍不放行；有密钥时先验证消息库再查询资料', async () => {
  const dir = fixture();
  const plain = Buffer.alloc(1040);
  plain.write('SQLite format 3\0');
  writeFileSync(join(dir, 'profile_info.db'), plain);
  writeFileSync(join(dir, 'nt_msg.db'), 'encrypted');
  const executeSql = vi.fn();
  const testDatabaseKey = vi.fn(async () => ({ success: false }));
  const nt = { executeSql, testDatabaseKey } as unknown as NtHelperBinding;
  expect(await inspectBackupDatabases(nt, { dirPath: dir })).toEqual({ status: 'needKey' });
  expect(
    await inspectBackupDatabases(nt, { dirPath: dir, dbKey: 'synthetic-wrong' }),
  ).toMatchObject({ status: 'error' });
  expect(testDatabaseKey).toHaveBeenCalledOnce();
  expect(executeSql).not.toHaveBeenCalled();
});

it('密钥校验通过后从消息库取身份，资料库表结构不认识也不影响', async () => {
  const dir = fixture();
  // 消息库用真实夹具：里面有本人发出的行（40020 是本账号 uid，40021 恒为对端）。
  const msg = fixtureDb(join(dir, 'nt_msg.db'));
  msg.exec(
    `CREATE TABLE c2c_msg_table ("40001" INTEGER,"40003" INTEGER,"40020" TEXT,"40021" TEXT,"40027" TEXT,"40033" INTEGER,"40040" INTEGER,"40050" INTEGER,"40800" BLOB)`,
  );
  msg
    .prepare(
      `INSERT INTO c2c_msg_table ("40001","40003","40020","40021","40033","40050") VALUES (?,?,?,?,?,?)`,
    )
    .run(1, 1, 'u_self', 'u_peer', 12345, 1);
  // 资料库是空库：没有 profile_info_vN 表，旧实现会在这里报错。
  fixtureDb(join(dir, 'profile_info.db'));
  const testDatabaseKey = vi.fn(async () => ({
    success: true,
    pageHmacAlgorithm: 'hmac-sha1',
    kdfHmacAlgorithm: 'pbkdf2-sha512',
  }));
  // 明文夹具库：把原生查询直接转给 node:sqlite，验证身份确实来自消息库。
  // 有密钥时 QqDb 走 `executeSqlWithKey`（夹具库本身是明文，忽略密钥参数）。
  // 原生接口返回的是**位置数组**，而 node:sqlite 给的是对象，这里按列序转换。
  const run = async (dbPath: string, sql: string, params?: unknown[]) => {
    const stmt = fixtureDb(dbPath).prepare(sql);
    const columns = stmt.columns().map((column) => column.name);
    return stmt
      .all(...((params ?? []) as never[]))
      .map((row) => columns.map((name) => (row as Record<string, unknown>)[name]));
  };
  const executeSql = vi.fn(run);
  const executeSqlWithKey = vi.fn(
    (dbPath: string, sql: string, _key: string, _algo: unknown, params?: unknown[]) =>
      run(dbPath, sql, params),
  );
  // QqDb.close() 会回调原生关连接，桩里给个空实现。
  const closeDb = vi.fn();
  const nt = {
    executeSql,
    executeSqlWithKey,
    testDatabaseKey,
    closeDb,
  } as unknown as NtHelperBinding;

  expect(await inspectBackupDatabases(nt, { dirPath: dir, dbKey: 'synthetic' })).toMatchObject({
    status: 'ready',
    preview: { uin: '12345', uid: 'u_self' },
  });
});
