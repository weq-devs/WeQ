import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { C2cMsgDb, GroupMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let dir = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('年度候选、私聊日桶和两类作息按北京时间读取真实发送时间', async () => {
  dir = mkdtempSync(join(tmpdir(), 'weq-report-time-'));
  const path = join(dir, 'nt_msg.db');
  const sql = fixtureDb(path);
  const boundary = Date.parse('2026-01-01T00:00:00+08:00') / 1000;
  for (const table of ['c2c_msg_table', 'group_msg_table']) {
    sql.exec(
      `CREATE TABLE ${table} ("40020" TEXT,"40021" TEXT,"40033" INTEGER,"40040" INTEGER,"40050" INTEGER,"40058" INTEGER)`,
    );
    const add = sql.prepare(`INSERT INTO ${table} VALUES ('u_self','u_peer',10001,1,?,?)`);
    // 日字段缺失或滞后也不能让真实消息年份从工具中消失。
    add.run(boundary - 1, 0);
    add.run(boundary, boundary - 86400);
    add.run(boundary + 86400, null);
    add.run(0, boundary);
  }
  const c2c = new C2cMsgDb(createSqliteStub(), { dbPath: path });
  const group = new GroupMsgDb(createSqliteStub(), { dbPath: path });
  expect((await c2c.yearsWithMessages()).sort()).toEqual([2025, 2026]);
  expect((await group.yearsWithMessages()).sort()).toEqual([2025, 2026]);
  expect((await c2c.peerDayTallies()).sort((a, b) => a.date.localeCompare(b.date))).toEqual([
    { peerUid: 'u_peer', date: '2025-12-31', total: 1, mine: 1 },
    { peerUid: 'u_peer', date: '2026-01-01', total: 1, mine: 1 },
    { peerUid: 'u_peer', date: '2026-01-02', total: 1, mine: 1 },
  ]);
  const expected = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  expected[3]![23] = 1;
  expected[4]![0] = 1;
  expected[5]![0] = 1;
  expect(await c2c.sentWeekdayHourlyTallies()).toEqual(expected);
  expect(await group.sentWeekdayHourlyTallies({ senderUid: 'u_self' })).toEqual(expected);
  expect(await c2c.countByDirection({ startTime: boundary, endTime: boundary + 86400 })).toEqual({
    sent: 1,
    received: 0,
  });
  const filtered = await group.sentWeekdayHourlyTallies({
    selfUin: 10001n,
    startTime: boundary,
    endTime: boundary + 86400,
  });
  expect(filtered.flat().reduce((a, b) => a + b, 0)).toBe(1);
  expect(filtered[4]![0]).toBe(1);
});
