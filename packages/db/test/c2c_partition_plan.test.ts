import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { C2cMsgDb } from '@weq/db';
import { DATABASE_SCAN_PAGE_SIZE } from '../src/qq_db';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';

let root: string;
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
it('实际分页 SQL 的 sortNo 路径使用现有复合索引，UID 回退分段扫描且保留完整结果', async () => {
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
  const indexedLatest = await db.listLatest({ sortNo: 42n }, 1);
  const fallbackLatest = await db.listLatest({ uid: 'u_peer' }, 1);
  expect(indexed.map((row) => row.msgId)).toEqual([1n]);
  expect(fallback.map((row) => row.msgId)).toEqual([1n]);
  expect(indexedLatest).toEqual(fallbackLatest);
  expect(indexedLatest.map((row) => row.msgId)).toEqual([1n]);
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
  expect(plans[1]).toContain('SEARCH c2c_msg_table USING INDEX known_partition_seq');
  const fallbackQueries = execute.mock.calls.filter(([, query]) =>
    query.includes('FROM "c2c_msg_table"'),
  );
  expect(fallbackQueries.length).toBeGreaterThan(0);
  for (const [, query, params] of fallbackQueries) {
    if (query.includes('MAX(rowid)')) continue;
    expect(query).toContain('ORDER BY rowid LIMIT ?');
    expect(Number(params?.at(-1))).toBeLessThanOrEqual(DATABASE_SCAN_PAGE_SIZE);
    expect(query).toContain('page AS MATERIALIZED');
  }
  sql.exec(`INSERT INTO c2c_msg_table("40001","40003","40005","40021","40027","40050") VALUES
    (9007199254740993001,12,100,'u_peer',42,1002),
    (9007199254740993002,12,200,'u_peer',42,1002)`);
  const first = await db.listHistory(
    { sortNo: 42n },
    { min: 1n, max: 100n, descending: true, limit: 1 },
  );
  const second = await db.listHistory(
    { uid: 'u_peer' },
    { min: 1n, max: 100n, descending: true, limit: 1, cursor: first[0]! },
  );
  expect(first[0]?.msgId).toBe(9007199254740993002n);
  expect(second[0]?.msgId).toBe(9007199254740993001n);
  expect(first[0]?.clientSeq).toBe(200n);
});

it('UID 分段读取跨稀疏负数及 64 位 rowid，跨分区和同序号排序与原 SQL 一致', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-uid-pages-'));
  const dbPath = join(root, 'msg.db'),
    sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE c2c_msg_table (
    "40001" INTEGER PRIMARY KEY,"40002" INTEGER,"40003" INTEGER,"40005" INTEGER,"40011" INTEGER,"40012" INTEGER,"40013" INTEGER,
    "40020" TEXT,"40021" TEXT,"40027" INTEGER,"40030" INTEGER,"40033" INTEGER,"40050" INTEGER,"40800" BLOB,"40801" BLOB);
    CREATE INDEX known_partition_seq ON c2c_msg_table("40027","40003")`);
  const insert = sql.prepare(
    'INSERT INTO c2c_msg_table("40001","40003","40021","40027","40050") VALUES(?,?,?,?,?)',
  );
  insert.setReadBigInts(true);
  for (let i = 0; i < 145; i++)
    insert.run(
      9007199254740993000n + BigInt(i * 19),
      i % 23,
      i % 7 ? 'u_peer' : 'u_other',
      i % 3,
      i % 11,
    );
  insert.run(-9223372036854775808n, null, 'u_peer', null, null);
  insert.run(-7n, 0, 'u_peer', null, 0);
  const db = new C2cMsgDb(createSqliteStub(), { dbPath });
  const expected = (condition: string, direction: string) => {
    const statement =
      sql.prepare(`SELECT "40001" FROM c2c_msg_table WHERE "40021"='u_peer' ${condition}
      ORDER BY "40003" ${direction},"40050" ${direction},"40001" ${direction} LIMIT 30`);
    statement.setReadBigInts(true);
    return statement.all().map((row) => row['40001']);
  };
  expect((await db.listLatest({ uid: 'u_peer' }, 30)).map((row) => row.msgId)).toEqual(
    expected('', 'DESC'),
  );
  expect((await db.listBefore({ uid: 'u_peer' }, 13n, 30)).map((row) => row.msgId)).toEqual(
    expected('AND "40003"<13', 'DESC'),
  );
  expect((await db.listAfter({ uid: 'u_peer' }, 8n, 30)).map((row) => row.msgId)).toEqual(
    expected('AND "40003">8', 'ASC'),
  );
  expect((await db.listFrom({ uid: 'u_peer' }, 8n, 30)).map((row) => row.msgId)).toEqual(
    expected('AND "40003">=8', 'DESC'),
  );
  expect(await db.listLatest({ uid: 'u_absent' }, 30)).toEqual([]);
  expect(await db.listLatest({ uid: 'u_peer' }, 0)).toEqual([]);
});
