import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CalendarMetadataDb, QqDb, type CalendarCursor } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(indexed: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'weq-calendar-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE group_msg_table("40001" INTEGER PRIMARY KEY,"40003" INTEGER,"40050" INTEGER,"40027" INTEGER,"40040" INTEGER);
    INSERT INTO group_msg_table VALUES(-9,0,100,10,NULL),(1,1,100,10,NULL),(2,2,100,20,0),(3,3,100,10,0),(4,4,100,10,1),(5,5,101,10,1),(6,6,102,10,1);`);
  if (indexed) sql.exec('CREATE INDEX time_dir ON group_msg_table("40050","40040")');
  const nt = createSqliteStub();
  return {
    reader: new CalendarMetadataDb(new QqDb(nt, { dbPath: path }), 'group_msg_table'),
    nt,
    path,
    sql,
  };
}
it.each([true, false])('元数据分页不丢同时间、NULL source、负 rowid，索引=%s', async (indexed) => {
  const { reader, nt } = fixture(indexed);
  const spy = vi.spyOn(nt, 'executeSql');
  let cursor: CalendarCursor | undefined;
  const ids = [];
  for (;;) {
    const page = await reader.page(100, 102, cursor, 2);
    ids.push(...page.items.map((row) => row.id));
    cursor = page.cursor;
    if (page.done) break;
  }
  expect(ids).toEqual(['-9', '1', '2', '3', '4', '5']);
  expect(new Set(ids).size).toBe(ids.length);
  expect(spy.mock.calls.every(([, query]) => !query.includes('40800'))).toBe(true);
});
it('计数使用真实索引，遵循会话范围、半开日期和隐藏删除', async () => {
  const { reader } = fixture(true);
  expect(await reader.count(['10'], 100, 102, ['3'])).toBe(4);
  expect(await reader.count(['20'], 100, 102, [])).toBe(1);
  expect(await reader.exists('-9')).toBe(true);
  expect(await reader.exists('123')).toBe(false);
});
it('缺失时间索引不做无界 COUNT', async () => {
  const { reader, nt } = fixture(false);
  const spy = vi.spyOn(nt, 'executeSql');
  expect(await reader.count(['10'], 100, 102, [])).toBeNull();
  expect(spy.mock.calls.some(([, query]) => query.includes('COUNT(*)'))).toBe(false);
});
it('大范围过滤转为元数据续查，不拼接巨量 SQL 参数', async () => {
  const { reader, nt } = fixture(true);
  const spy = vi.spyOn(nt, 'executeSql');
  expect(
    await reader.count(
      Array.from({ length: 10000 }, () => '10'),
      100,
      102,
      [],
    ),
  ).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});
