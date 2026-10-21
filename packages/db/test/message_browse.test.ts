import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GroupMsgDb, C2cMsgDb } from '@weq/db';
import { fixtureDb, createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';

let dir = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'weq-browse-'));
  const path = join(dir, 'nt_msg.db');
  const sql = fixtureDb(path);
  for (const table of ['group_msg_table', 'c2c_msg_table']) {
    sql.exec(
      `CREATE TABLE ${table} ("40001" INTEGER,"40002" INTEGER,"40003" INTEGER,"40005" INTEGER,"40011" INTEGER,"40012" INTEGER,"40020" TEXT,"40021" TEXT,"40027" TEXT,"40030" INTEGER,"40033" INTEGER,"40050" INTEGER,"40062" BLOB,"40800" BLOB,"40801" BLOB)`,
    );
    const add = sql.prepare(
      `INSERT INTO ${table} ("40001","40003","40020","40021","40027","40033","40050") VALUES(?,?,?,?,?,?,?)`,
    );
    sql.exec(`ALTER TABLE ${table} ADD COLUMN "40013" INTEGER DEFAULT 0`);
    // 私聊专用：带 40002（random）/ 40005（client sequence）的行，用来钉住列映射
    // 不错位 —— SELECT_COLUMNS 是按位置索引的，新列只能追加在末尾。
    const addIds = sql.prepare(
      `INSERT INTO ${table} ("40001","40002","40003","40005","40020","40021","40027","40033","40050") VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    const midnight = Date.parse('2026-10-15T00:00:00+08:00') / 1000;
    // 单独一个会话（'888'），免得改动上面那批既有断言用的行序。
    addIds.run(8, 424242, 13, 6851, 'u_bob', 'u_peer2', '888', 456, midnight + 2);
    addIds.run(9, 0, 14, null, 'u_bob', 'u_peer2', '888', 456, midnight + 3);
    add.run(1, 10, 'u_alice', 'u_peer', '777', 123, midnight - 1);
    add.run(2, 11, 'u_alice', 'u_peer', '777', 123, midnight);
    add.run(3, 11, 'u_bob', 'u_peer', '777', 456, midnight);
    add.run(4, 0, 'u_alice', 'u_peer', '777', 123, midnight + 1);
    add.run(5, 12, 'u_alice', 'u_other', '999', 123, midnight);
    add.run(6, 0, 'u_alice', 'u_peer', '777', 123, null);
    add.run(7, 0, 'u_alice', 'u_peer', '777', 123, null);
  }
  return {
    group: new GroupMsgDb(createSqliteStub(), { dbPath: path }),
    c2c: new C2cMsgDb(createSqliteStub(), { dbPath: path }),
  };
}
it('calendar groups by Beijing date and never leaks another conversation', async () => {
  const { group, c2c } = fixture();
  expect(await group.calendar('777')).toEqual([
    { day: '2026-10-14', count: 1 },
    { day: '2026-10-15', count: 3 },
  ]);
  expect(await c2c.calendar({ uid: 'u_peer' })).toEqual(await group.calendar('777'));
});
it('date boundary uses chronological time and reports no usable seq explicitly', async () => {
  const { group } = fixture();
  const start = Date.parse('2026-10-15T00:00:00+08:00') / 1000;
  expect((await group.boundary('777', false, { start, end: start + 86399 }))?.msgId).toBe('2');
  expect((await group.boundary('777', true))?.msgId).toBe('3');
  expect(await group.boundary('777', false, { start: start + 1 })).toBeNull();
});
it('browse cursor handles same-time/same-seq rows without skipping and includes seqless records', async () => {
  const { group } = fixture();
  const first = await group.browse('777', {}, undefined, 2);
  expect(first.map((row) => String(row.message.msgId))).toEqual(['4', '3']);
  const last = first[1]!;
  const next = await group.browse(
    '777',
    {},
    { time: Number(last.message.sendTime), rowId: last.rowId },
    2,
  );
  expect(next.map((row) => String(row.message.msgId))).toEqual(['2', '1']);
  const lastNext = next[1]!;
  const undated = await group.browse(
    '777',
    {},
    { time: Number(lastNext.message.sendTime), rowId: lastNext.rowId },
    1,
  );
  expect(undated.map((row) => String(row.message.msgId))).toEqual(['7']);
  expect(
    (await group.browse('777', {}, { time: 0, rowId: undated[0]!.rowId }, 1)).map((row) =>
      String(row.message.msgId),
    ),
  ).toEqual(['6']);
});
it('sender UID/UIN and inclusive date bounds combine using bound SQL parameters', async () => {
  const { group, c2c } = fixture();
  const start = Date.parse('2026-10-15T00:00:00+08:00') / 1000;
  const filter = { start, end: start, sender: '123' };
  expect((await group.browse('777', filter)).map((row) => String(row.message.msgId))).toEqual([
    '2',
  ]);
  expect(
    (await c2c.browse({ uid: 'u_peer' }, { ...filter, sender: 'u_alice' })).map((row) =>
      String(row.message.msgId),
    ),
  ).toEqual(['2']);
  expect(await group.browse('777', { sender: "123' OR 1=1 --" })).toEqual([]);
});

it('正序浏览按时间与行号完整翻页，不遗漏空序号或同时间记录', async () => {
  const { c2c, group } = fixture();
  const first = await c2c.browse({ uid: 'u_peer' }, {}, undefined, 2, 'newer');
  expect(first.map((row) => String(row.message.msgId))).toEqual(['6', '7']);
  const last = first.at(-1)!;
  const second = await c2c.browse(
    { uid: 'u_peer' },
    {},
    { time: Number(last.message.sendTime), rowId: last.rowId },
    2,
    'newer',
  );
  expect(second.map((row) => String(row.message.msgId))).toEqual(['1', '2']);
  const anchor = second.at(-1)!;
  expect(
    (
      await group.browse(
        '777',
        {},
        { time: Number(anchor.message.sendTime), rowId: anchor.rowId },
        2,
        'newer',
      )
    ).map((row) => String(row.message.msgId)),
  ).toEqual(['3', '4']);
  const timeline = await group.browseSenderTimeline('777', {}, undefined, 2);
  expect(timeline.map((row) => row.rowId)).toEqual(first.map((row) => row.rowId));
  const midnight = Date.parse('2026-10-15T00:00:00+08:00') / 1000;
  expect(await group.countBySenders('777', { start: midnight, end: midnight })).toEqual({
    u_alice: 1,
    u_bob: 1,
  });
});

it('私聊行把 40005 映射成 clientSeq，且不挤动 40002/40801 的位置', async () => {
  const { c2c } = fixture();
  const rows = await c2c.listLatest({ uid: 'u_peer2' }, 20);
  const withIds = rows.find((row) => row.msgId === 8n);
  expect(withIds?.msgSeq).toBe(13n);
  // 列是追加在 SELECT_COLUMNS 末尾的：位置错一格就会把 random / 装扮串成别的字段。
  expect(withIds?.clientSeq).toBe(6851n);
  expect(withIds?.msgRandom).toBe(424242n);
  expect(withIds?.decoration).toBeUndefined();
  expect(withIds?.sendType).toBe(0n);
  // 没有该列的老行不受影响：clientSeq 缺席（0n）而不是填到别人的值。
  expect(rows.find((row) => row.msgId === 9n)?.clientSeq).toBe(0n);
});
