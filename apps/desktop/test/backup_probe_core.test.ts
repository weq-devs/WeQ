import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { NtHelperBinding } from '@weq/native';
import { inspectBackupDatabases, isPlainBackupDatabase } from '../src/main/backup_probe_core';

const roots: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-probe-core-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
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
