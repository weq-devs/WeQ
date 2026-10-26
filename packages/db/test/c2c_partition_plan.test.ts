import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { C2cMsgDb } from '@weq/db';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';

let root: string;
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
it('实际分页 SQL 的 sortNo 路径使用现有复合索引，UID 回退仍准确且确实扫描', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-partition-plan-'));
  const dbPath = join(root, 'msg.db'),
    sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE c2c_msg_table (
    "40001" INTEGER PRIMARY KEY,"40002" INTEGER,"40003" INTEGER,"40005" INTEGER,"40011" INTEGER,"40012" INTEGER,"40013" INTEGER,
    "40020" TEXT,"40021" TEXT,"40027" INTEGER,"40030" INTEGER,"40033" INTEGER,"40050" INTEGER,"40800" BLOB,"40801" BLOB);
    CREATE INDEX known_partition_seq ON c2c_msg_table("40027","40003");
    INSERT INTO c2c_msg_table("40001","40003","40021","40027","40050") VALUES (1,10,'u_peer',42,1000),(2,11,'u_other',43,1001)`);
  const nt = createSqliteStub(),
    execute = vi.spyOn(nt, 'executeSql');
  const db = new C2cMsgDb(nt, { dbPath });
  const indexed = await db.listAfter({ sortNo: 42n }, 0n, 50);
  const fallback = await db.listAfter({ uid: 'u_peer' }, 0n, 50);
  expect(indexed.map((row) => row.msgId)).toEqual([1n]);
  expect(fallback.map((row) => row.msgId)).toEqual([1n]);
  const plans = execute.mock.calls
    .filter(([, query]) => query.includes('SELECT "40001"'))
    .map(([, query, params]) => {
      const statement = sql.prepare(`EXPLAIN QUERY PLAN ${query}`);
      statement.setReadBigInts(true);
      return statement
        .all(...(params ?? []))
        .map((row) => String(row.detail))
        .join('\n');
    });
  expect(plans[0]).toContain('SEARCH c2c_msg_table USING INDEX known_partition_seq');
  expect(plans[1]).toContain('SCAN c2c_msg_table');
});
