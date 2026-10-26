import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { AnnualReportIndexDb, withDatabasePriority } from '@weq/db';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';

let root: string;
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
it('索引已存在不重建；每个缺失索引在授权空闲后才建，取消不继续触库', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-annual-idle-'));
  const dbPath = join(root, 'msg.db'),
    sql = fixtureDb(dbPath);
  for (const table of ['c2c_msg_table', 'group_msg_table'])
    sql.exec(`CREATE TABLE ${table} ("40050" INTEGER, "40040" INTEGER)`);
  const nt = createSqliteStub(),
    write = vi.spyOn(nt, 'executeSqlWrite');
  const db = new AnnualReportIndexDb(nt, { dbPath });
  const beforeCreate = vi.fn(async () => false);
  expect(await db.ensure({ beforeCreate })).toEqual([]);
  expect(write).not.toHaveBeenCalled();
  beforeCreate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await db.ensure({ beforeCreate })).toHaveLength(1);
  expect(write).toHaveBeenCalledOnce();
  beforeCreate.mockResolvedValue(true);
  expect(await db.ensure({ beforeCreate })).toHaveLength(2);
  expect(write).toHaveBeenCalledTimes(2);
  beforeCreate.mockClear();
  expect(await db.ensure({ beforeCreate })).toHaveLength(2);
  expect(beforeCreate).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledTimes(2);
});

it('空闲检查通过后才切号，也不会发出排队的旧来源写入', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-annual-cancel-'));
  const dbPath = join(root, 'msg.db'),
    sql = fixtureDb(dbPath);
  for (const table of ['c2c_msg_table', 'group_msg_table'])
    sql.exec(`CREATE TABLE ${table} ("40050" INTEGER, "40040" INTEGER)`);
  const nt = createSqliteStub(),
    write = vi.spyOn(nt, 'executeSqlWrite');
  const controller = new AbortController();
  const db = new AnnualReportIndexDb(nt, { dbPath });
  await expect(
    withDatabasePriority(
      'background',
      () =>
        db.ensure({
          beforeCreate: async () => {
            controller.abort();
            return true;
          },
        }),
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(write).not.toHaveBeenCalled();
});
