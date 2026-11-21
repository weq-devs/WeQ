import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { C2cMsgDb, GroupMsgDb, GroupMemberDb } from '@weq/db';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';
let root = '';
const close: Array<() => void> = [];
afterEach(() => {
  for (const fn of close.splice(0)) fn();
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
// 独立 wire：MsgBody@40800 → elementType@45002=1、textContent@45101。
const text = Buffer.from('82f6130bd0fc1501ea821603686579', 'hex');
it('群目录取各群最大的正序号，保留历史群和整数精度', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-directory-seqs-'));
  const path = join(root, 'messages.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE group_msg_table ("40027" TEXT, "40003" INTEGER, "40050" INTEGER);
    CREATE INDEX group_partition_seq ON group_msg_table ("40027", "40003");
    INSERT INTO group_msg_table VALUES
      ('10001',9007199254740993,100),('10001',9007199254740992,200),
      ('10002',42,300),('10003',0,400),('10004',NULL,500),(NULL,99,600);`);
  const db = new GroupMsgDb(createSqliteStub(), { dbPath: path });
  close.push(() => db.close());
  expect(await db.directoryMaxSeqs()).toEqual({ '10001': '9007199254740993', '10002': '42' });
  sql.exec('DELETE FROM group_msg_table');
  expect(await db.directoryMaxSeqs()).toEqual({});
});
it('本人入群时间以 UID 为准，空 UID 仅按本人号码补全，不拿其他人的记录兜底', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-directory-joins-'));
  const path = join(root, 'members.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE group_member3 ("60001" INTEGER,"64007" INTEGER,"1000" TEXT,"1002" INTEGER,"64016" INTEGER);
    INSERT INTO group_member3 VALUES (1,100,'u_me',123,0),(1,200,'',123,0),(2,150,'',123,NULL),(3,999,'',999,0),(4,160,'u_other',123,0),(5,170,'u_me',123,1);`);
  const db = new GroupMemberDb(createSqliteStub(), { dbPath: path });
  close.push(() => db.close());
  expect(await db.selfJoinTimes('u_me', '123')).toEqual({ '1': 100, '2': 150 });
  expect(await db.selfJoinTimes('', '123')).toEqual({ '1': 200, '2': 150 });
});
it('真实 SQLite 私聊：有界游标、乱序时间、失败、系统和删除占位', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-directory-times-'));
  const path = join(root, 'messages.db');
  const sql = fixtureDb(path);
  const table = 'c2c_msg_table';
  const column = '40021';
  sql.exec(
    `CREATE TABLE ${table} ("${column}" TEXT,"40050" INTEGER,"40020" TEXT,"40033" INTEGER,"40011" INTEGER,"40041" INTEGER,"40800" BLOB)`,
  );
  const insert = sql.prepare(
    `INSERT INTO ${table} (rowid,"${column}","40050","40020","40033","40011","40041","40800") VALUES (?,'u_peer',?,'u_me',123,?,?,?)`,
  );
  insert.setReadBigInts(true);
  for (let i = 0; i < 130; i++)
    insert.run(9007199254740993n + BigInt(i), i === 0 ? 10000 : i + 1, 2, 2, text);
  insert.run(9007199254742000n, 20000, 2, 1, text);
  insert.run(9007199254742001n, 20001, 5, 2, text);
  insert.run(9007199254742002n, 20002, 1, 2, text);
  const nt = createSqliteStub();
  const db = new C2cMsgDb(nt, { dbPath: path });
  close.push(() => db.close());
  const first = await db.directoryTimePage();
  expect(first.done).toBe(false);
  expect(first.items).toHaveLength(125);
  const second = await db.directoryTimePage(first.cursor);
  expect(second.done).toBe(true);
  expect(second.items).toHaveLength(5);
  expect(
    Math.max(...first.items.map((row) => row.time), ...second.items.map((row) => row.time)),
  ).toBe(10000);
  expect(second.cursor).toBe('9007199254740993');
  expect(new Set([...first.items, ...second.items].map((row) => row.time)).size).toBe(130);
  sql.exec(`DELETE FROM ${table}`);
  expect((await db.directoryTimePage()).items).toEqual([]);
});

it('群目录核对会话摘要，定向按消息时间读取并可以回退到较早的有效消息', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-directory-group-times-'));
  const path = join(root, 'messages.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE group_msg_table (
      "40027" TEXT,"40003" INTEGER,"40001" INTEGER,"40050" INTEGER,"40020" TEXT,
      "40033" INTEGER,"40011" INTEGER,"40041" INTEGER,"40800" BLOB);
    CREATE INDEX group_partition_seq ON group_msg_table ("40027", "40003");
    CREATE TABLE recent_contact_v3_table (
      "40021" TEXT,"40010" INTEGER,"40003" INTEGER,"40001" INTEGER,"40050" INTEGER);
    INSERT INTO recent_contact_v3_table VALUES
      ('10001',2,3,33,500),('10002',2,2,10,700),('10003',2,3,33,900),('10004',1,3,33,800);`);
  const insert = sql.prepare(`INSERT INTO group_msg_table VALUES (?,?,?,?,?,?,?,?,?)`);
  insert.run('10001', 3, 33, 500, 'u_other', 123, 2, 2, text);
  insert.run('10001', 6, 66, 400, '', 123, 2, 2, text);
  insert.run('10001', 7, 77, 450, 'u_other', 123, 2, 2, text);
  insert.run('10001', 8, 88, 600, 'u_me', 123, 5, 2, text);
  for (let seq = 20; seq < 39; seq++)
    insert.run('10001', seq, seq, 550, 'u_me', 123, 2, 2, Buffer.alloc(0));
  insert.run('10002', 2, 20, 700, 'u_me', 123, 2, 2, text);
  insert.run('10003', 3, 33, 900, 'u_me', 123, 2, 1, text);
  insert.run('10004', 3, 33, 800, 'u_me', 123, 2, 2, text);
  const db = new GroupMsgDb(createSqliteStub(), { dbPath: path });
  close.push(() => db.close());

  expect(
    await db.recentDirectoryTimes(['10001', '10002', '10003', '10004'], 'u_me', '123'),
  ).toEqual({ '10001': { time: 500 } });
  expect(await db.directoryTimes('10001', 'u_me', '123')).toEqual({ time: 500, mine: 400 });
  expect(await db.directoryTimes('10003', 'u_me', '123')).toEqual({ time: null, mine: null });
  sql.exec(`DELETE FROM group_msg_table WHERE "40027"='10001' AND "40001"=33`);
  expect(await db.directoryTimes('10001', 'u_me', '123')).toEqual({ time: 450, mine: 400 });
});
