import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BuddyDb, C2cMsgDb, GroupMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([false, true])(
  '年份探测复用时间索引或短分页，不做整表 DISTINCT，indexed=%s',
  async (indexed) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-startup-years-'));
    roots.push(root);
    const path = join(root, 'msg.db'),
      sql = fixtureDb(path),
      nt = createSqliteStub();
    for (const table of ['c2c_msg_table', 'group_msg_table']) {
      sql.exec(`CREATE TABLE ${table}("40050" INTEGER)`);
      const insert = sql.prepare(`INSERT INTO ${table} VALUES(?)`);
      for (const value of [
        0,
        0.5,
        -1,
        null,
        253402272000,
        253402271999,
        Date.parse('2026-01-01T00:00:00+08:00') / 1000 - 1,
        Date.parse('2026-01-01T00:00:00+08:00') / 1000 - 0.5,
        Date.parse('2026-01-01T00:00:00+08:00') / 1000,
      ])
        insert.run(value);
      if (indexed) sql.exec(`CREATE INDEX ${table}_time ON ${table}("40050")`);
      const reference = sql
        .prepare(`SELECT DISTINCT CAST(strftime('%Y', day*86400, 'unixepoch') AS INTEGER) AS y
      FROM (SELECT DISTINCT CAST(("40050"+28800)/86400 AS INTEGER) AS day FROM ${table} WHERE "40050">0)`)
        .all()
        .map((row) => Number(row.y ?? 0))
        .filter((year) => year > 0)
        .sort((a, b) => a - b);
      const execute = vi.spyOn(nt, 'executeSql');
      execute.mockClear();
      const reader =
        table === 'c2c_msg_table'
          ? new C2cMsgDb(nt, { dbPath: path })
          : new GroupMsgDb(nt, { dbPath: path });
      expect((await reader.yearsWithMessages()).sort((a, b) => a - b)).toEqual(reference);
      for (const [, query] of execute.mock.calls) expect(query).not.toContain('SELECT DISTINCT');
      if (indexed)
        expect(
          execute.mock.calls.some(([, query]) => query.includes('ORDER BY "40050" LIMIT 1')),
        ).toBe(true);
    }
  },
);

it('好友目录无上限读取和带偏移读取均分段，返回相同顺序与完整范围', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-startup-buddies-'));
  roots.push(root);
  const path = join(root, 'profile.db'),
    sql = fixtureDb(path),
    nt = createSqliteStub();
  sql.exec('CREATE TABLE buddy_list("1000" TEXT,"1001" TEXT,"1002" INTEGER,"25007" INTEGER)');
  const insert = sql.prepare('INSERT INTO buddy_list VALUES(?,?,?,?)');
  for (let i = 0; i < 600; i++) insert.run(`u_${i}`, `qid_${i}`, 10000 + i, i % 3);
  const execute = vi.spyOn(nt, 'executeSql');
  const reader = new BuddyDb(nt, { dbPath: path });
  const all = await reader.listBuddies();
  expect(all).toHaveLength(600);
  expect(await reader.listBuddies(300, 240)).toEqual(all.slice(240, 540));
  expect(execute.mock.calls.some(([, query]) => query.includes('ORDER BY rowid LIMIT ?'))).toBe(
    true,
  );
  for (const [, query] of execute.mock.calls)
    if (query.includes('FROM "buddy_list"') && !query.includes('MAX(rowid)'))
      expect(query).toContain('LIMIT ?');
});
