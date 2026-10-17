import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupMsgDb } from '../src/msg/group';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let dir: string;
let db: GroupMsgDb;
afterEach(() => {
  db?.close();
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 本地时间 → unix 秒（走真实 Date，避免测试自己实现时区偏移）。 */
function at(year: number, month: number, day: number): number {
  return Math.floor(new Date(year, month - 1, day, 12, 0, 0).getTime() / 1000);
}

describe('countWeeklyByGroups', () => {
  it('按群 + 周聚合，周序号以窗口起始日为 0', async () => {
    dir = mkdtempSync(join(tmpdir(), 'weq-group-weekly-'));
    const dbPath = join(dir, 'nt_msg.db');
    const sql = fixtureDb(dbPath);
    sql.exec(`CREATE TABLE group_msg_table ("40027" TEXT, "40050" INTEGER, "40020" TEXT);`);
    const insert = sql.prepare(`INSERT INTO group_msg_table VALUES (?, ?, ?)`);
    // 2026-01-01 是周四；Jan 1..7 = week 0，Jan 8..14 = week 1，Dec 31 = week 52。
    insert.run('10001', at(2026, 1, 1), 'u1');
    insert.run('10001', at(2026, 1, 7), 'u2');
    insert.run('10001', at(2026, 1, 8), 'u1');
    insert.run('10001', at(2026, 1, 14), 'u1');
    insert.run('10001', at(2026, 12, 31), 'u1');
    insert.run('10002', at(2026, 1, 8), 'u3');
    // 窗口外的行不应计入。
    insert.run('10001', at(2025, 12, 31), 'u1');
    insert.run('10001', at(2027, 1, 1), 'u1');

    db = new GroupMsgDb(createSqliteStub(), { dbPath });
    const rows = await db.countWeeklyByGroups(['10001', '10002'], {
      startTime: at(2026, 1, 1),
      endTime: at(2026, 12, 31),
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { groupCode: '10001', week: 0, count: 2 },
        { groupCode: '10001', week: 1, count: 2 },
        { groupCode: '10001', week: 52, count: 1 },
        { groupCode: '10002', week: 1, count: 1 },
      ]),
    );
    expect(rows).toHaveLength(4);
  });

  it('没有群时直接返回空数组，不拼 SQL', async () => {
    dir = mkdtempSync(join(tmpdir(), 'weq-group-weekly-empty-'));
    db = new GroupMsgDb(createSqliteStub(), { dbPath: join(dir, 'nt_msg.db') });
    expect(await db.countWeeklyByGroups([], { startTime: 0, endTime: 0 })).toEqual([]);
  });
});
