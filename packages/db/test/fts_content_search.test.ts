import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import type { SqlRow } from '@weq/native';
import { BuddyMsgFtsDb } from '../src/msg/buddy_msg_fts';
import { GroupMsgFtsDb } from '../src/msg/group_msg_fts';
import { QqDb } from '../src/qq_db';
import { withDatabasePriority, withDatabaseSignal } from '../src/query_schedule';

const folders: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const folder of folders.splice(0)) rmSync(folder, { force: true, recursive: true });
});

function fixture(table: 'buddy_msg_fts' | 'group_msg_fts') {
  const folder = mkdtempSync(join(tmpdir(), 'weq-fts-content-'));
  folders.push(folder);
  const dbPath = join(folder, 'search.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE ${table} (
    "40001" INTEGER, "40003" INTEGER, "40010" INTEGER, "40020" TEXT, "40021" TEXT,
    "40027" INTEGER, "40050" INTEGER, "41701" TEXT, "41702" TEXT
  )`);
  const insert = sql.prepare(`INSERT INTO ${table} VALUES (?,1,2,'u_sender',?,?,?,?,?)`);
  sql.exec('BEGIN');
  for (let id = 1; id <= 1300; id++) insert.run(id, '234', 234, id, '普通正文', null);
  insert.run(2000, '123', 123, 3500, '业务报表', '进度%.txt');
  insert.run(2001, '123', 123, 3700, '业务报表', '进度x.txt');
  insert.run(2002, '234', 234, 3900, '业务报表', '另一群文件.txt');
  sql.exec(`UPDATE ${table} SET "41701"='业务报表',"40050"=4200 WHERE "40001"=1`);
  sql.exec('COMMIT');
  return { dbPath, nt: createSqliteStub() };
}

it('无预算接口也使用有界分页，旧 rowid 上的新消息不会被漏掉', async () => {
  const { dbPath, nt } = fixture('buddy_msg_fts');
  const query = vi.spyOn(nt, 'executeSql');
  const db = new BuddyMsgFtsDb(nt, { dbPath });
  expect((await db.search('业务报表', 4)).map(({ msgId }) => msgId)).toEqual([
    1n,
    2002n,
    2001n,
    2000n,
  ]);
  expect(
    query.mock.calls.filter(([, statement]) => statement.includes('page AS MATERIALIZED')),
  ).toHaveLength(3);
  expect((await db.searchFiles('进度%', 4)).map(({ msgId }) => msgId)).toEqual([2000n]);
  expect(
    (await db.searchInConversation({ uid: '123' }, '业务报表', 4)).map(({ msgId }) => msgId),
  ).toEqual([2001n, 2000n]);
});

it('长查询到预算后继续逐页读取，保留群分区和命中排序', async () => {
  const { dbPath, nt } = fixture('group_msg_fts');
  const sql = fixtureDb(dbPath);
  sql.exec('CREATE INDEX group_partition ON group_msg_fts("40027")');
  const scans: SqlRow[][] = [];
  const queries = vi.fn<NonNullable<typeof nt.executeSqlBudgeted>>(
    async (path, statement, params) => {
      if (statement.includes('ORDER BY "40050" DESC')) {
        throw new Error('database_query_execution_timeout');
      }
      const rows = await nt.executeSql(path, statement, params);
      if (statement.includes('page AS MATERIALIZED')) {
        const plan = sql.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...params);
        expect(
          plan.some(({ detail }) => String(detail).includes('USING INDEX group_partition')),
        ).toBe(true);
        scans.push(rows.slice());
      }
      return rows;
    },
  );
  nt.executeSqlBudgeted = queries;
  const db = new GroupMsgFtsDb(nt, { dbPath });
  expect((await db.searchInGroup('123', '业务报表', 2)).map(({ msgId }) => msgId)).toEqual([
    2001n,
    2000n,
  ]);
  expect(scans).toHaveLength(1);
  expect(scans[0]?.at(-1)?.[1]).toBe(2n);
});

it('无命中也能在两个扫描批次之间取消，停止后续读库', async () => {
  const { dbPath, nt } = fixture('group_msg_fts');
  const query = nt.executeSql;
  const abort = new AbortController();
  const bounded = vi.spyOn(nt, 'executeSql').mockImplementation(async (path, statement, params) => {
    const rows = await query(path, statement, params);
    if (statement.includes('page AS MATERIALIZED')) abort.abort();
    return rows;
  });
  const db = new GroupMsgFtsDb(nt, { dbPath });
  await expect(
    withDatabaseSignal(abort.signal, () => db.search('缺少关键字')),
  ).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(bounded).toHaveBeenCalledOnce();
});

it('扫描批次之间同库的交互读取可以先完成', async () => {
  const { dbPath, nt } = fixture('group_msg_fts');
  const search = new GroupMsgFtsDb(nt, { dbPath });
  const foreground = new QqDb(nt, { dbPath });
  const execute = nt.executeSql;
  const order: string[] = [];
  let latest: Promise<unknown> | undefined;
  vi.spyOn(nt, 'executeSql').mockImplementation(async (path, statement, params) => {
    const result = await execute(path, statement, params);
    if (statement.includes('page AS MATERIALIZED')) {
      order.push('扫描批次');
      latest ??= withDatabasePriority('interactive', () => foreground.query('SELECT 1'));
    } else order.push('交互读取');
    return result;
  });
  expect(await search.search('缺少关键字')).toEqual([]);
  await latest;
  expect(order).toEqual(['扫描批次', '交互读取', '扫描批次', '扫描批次']);
});
