import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';
import { GuildDirectMsgDb, type GuildMessageCursor } from '../src/guild';

let root = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'weq-guild-stable-'));
  const path = join(root, 'guild_msg.db');
  const sql = fixtureDb(path);
  sql.exec(
    'CREATE TABLE guild_msg_table ("40001" INTEGER PRIMARY KEY,"40003" INTEGER,"40027" INTEGER,"40026" INTEGER,"40025" TEXT,"40013" INTEGER,"40050" INTEGER,"40800" BLOB,"40011" INTEGER,"40012" INTEGER,"40801" BLOB); CREATE INDEX by_node_seq ON guild_msg_table("40027","40003")',
  );
  const add = sql.prepare(
    'INSERT INTO guild_msg_table ("40001","40003","40027","40050") VALUES (?,?,?,?)',
  );
  add.setReadBigInts(true);
  add.run(-5, null, 100, null);
  add.run(-4, 0, 100, 1);
  add.run(1, 1, 100, 2);
  add.run(2, 1, 100, 2);
  add.run(9007199254740993n, 1, 100, 2);
  add.run(5, 2, 100, 3);
  add.run(6, 0, 999, 0);
  return new GuildDirectMsgDb(createSqliteStub(), { dbPath: path });
}
it('真实 SQLite 游标跨同 seq/时间、零/NULL seq、负 ID 和 64 位 ID，不漏不重且不越会话', async () => {
  const db = fixture();
  const ids: string[] = [];
  let cursor: GuildMessageCursor | undefined;
  for (;;) {
    const page = await db.listStablePage(100n, cursor, 2);
    ids.push(...page.items.map((row) => String(row.msgId)));
    if (page.items.length < 2) break;
    cursor = page.cursor!;
  }
  expect(ids).toEqual(['-5', '-4', '1', '2', '9007199254740993', '5']);
});
it('精确定位以 nodeId/msgId 为准，零 seq 和同 seq 也能读取上下文', async () => {
  const db = fixture();
  expect((await db.aroundMessage(100n, -5n)).items.map((row) => String(row.msgId))).toEqual([
    '-5',
    '-4',
    '1',
    '2',
    '9007199254740993',
    '5',
  ]);
  expect(
    (await db.listBeforeMessage(100n, 9007199254740993n)).map((row) => String(row.msgId)),
  ).toEqual(['2', '1', '-4', '-5']);
  expect(await db.aroundMessage(100n, 6n)).toEqual({ found: false, hasMore: false, items: [] });
  expect((await db.listStableLatest(100n, 2)).map((row) => String(row.msgId))).toEqual([
    '5',
    '9007199254740993',
  ]);
});
