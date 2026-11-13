import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { createSqliteStub, closeAllFixtureDbs, fixtureDb } from '@weq/testkit';
import { DbExplorerService } from '../src/account/db_explorer';

let root = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
it('Remote SQL 使用真实只读路径，写语句和可写 PRAGMA 均不能修改数据库', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-remote-sql-'));
  const path = join(root, 'bc_09.db');
  const fixture = fixtureDb(path);
  fixture.exec('CREATE TABLE sample (n INTEGER); INSERT INTO sample VALUES (1)');
  const service = new DbExplorerService(
    { context: { uin: 10001, algos: {} } } as unknown as AccountSession,
    {
      ntDbDir: () => root,
      loginDbPath: () => '',
      native: { ntHelper: createSqliteStub() },
    } as unknown as Platform,
  );
  expect((await service.runSql(path, 'SELECT n FROM sample', true)).rows).toEqual([
    [{ t: 'int', v: '1' }],
  ]);
  await expect(service.runSql(path, 'UPDATE sample SET n=2', true)).rejects.toThrow('只读');
  await expect(
    service.runSql(path, 'WITH x AS (SELECT 1) DELETE FROM sample', true),
  ).rejects.toThrow();
  await expect(service.runSql(path, 'PRAGMA user_version=9', true)).rejects.toThrow('PRAGMA');
  expect(fixture.prepare('SELECT n FROM sample').get()?.n).toBe(1);
  await service.runSql(path, 'UPDATE sample SET n=3');
  expect(fixtureDb(path).prepare('SELECT n FROM sample').get()?.n).toBe(3);
});
