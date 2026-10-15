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
      `CREATE TABLE ${table} ("40001" INTEGER,"40002" INTEGER,"40003" INTEGER,"40011" INTEGER,"40012" INTEGER,"40020" TEXT,"40021" TEXT,"40027" TEXT,"40030" INTEGER,"40033" INTEGER,"40050" INTEGER,"40062" BLOB,"40800" BLOB,"40801" BLOB)`,
    );
    const add = sql.prepare(
      `INSERT INTO ${table} ("40001","40003","40020","40021","40027","40033","40050") VALUES(?,?,?,?,?,?,?)`,
    );
    const midnight = Date.parse('2026-10-15T00:00:00+08:00') / 1000;
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
