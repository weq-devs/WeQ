import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { QqDb } from '../src/qq_db';
import { withDatabasePriority } from '../src/query_schedule';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-short-pages-'));
  roots.push(root);
  const path = join(root, 'fixture.db');
  fixtureDb(path).exec(
    "CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('a'),('b'),('c'),('d'),('e')",
  );
  const nt = createSqliteStub();
  return { path, nt, db: new QqDb(nt, { dbPath: path }) };
}

it('超出原生预算时缩小同一未完成页，之后按实际页大小续读，不跳行', async () => {
  const f = fixture();
  const read = vi.fn(async (path, sql, params, budget) => {
    expect(budget).toBe(15);
    if (Number(params.at(-1)) > 2) throw new Error('database_query_execution_timeout');
    return f.nt.executeSql(path, sql, params);
  });
  f.nt.executeSqlBudgeted = read;
  const rows = [];
  for await (const page of f.db.rowidPages('items', ['value'], 8)) rows.push(...page);
  expect(rows.map((row) => row[1])).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(read.mock.calls.map((call) => Number(call[2].at(-1)))).toEqual([8, 4, 2, 2, 2]);
});

it('固定本轮上界，读取中追加的新行留待下轮，真正错误不当作预算重试', async () => {
  const f = fixture();
  const rows = [];
  for await (const page of f.db.rowidPages('items', ['value'], 2)) {
    rows.push(...page);
    if (rows.length === 2) fixtureDb(f.path).exec("INSERT INTO items VALUES ('new')");
  }
  expect(rows.map((row) => row[1])).toEqual(['a', 'b', 'c', 'd', 'e']);
  const failure = new Error('synthetic disk failure');
  f.nt.executeSqlBudgeted = vi.fn(async () => {
    throw failure;
  });
  await expect(f.db.queryPage('SELECT value FROM items LIMIT ?', [])).rejects.toBe(failure);
  expect(f.nt.executeSqlBudgeted).toHaveBeenCalledOnce();
});

it('页间取消立即终止，不继续原生读取或返回伪装完整结果', async () => {
  const f = fixture();
  const execute = vi.spyOn(f.nt, 'executeSql');
  const controller = new AbortController();
  await expect(
    withDatabasePriority(
      'background',
      async () => {
        for await (const _page of f.db.rowidPages('items', ['value'], 2)) controller.abort();
      },
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(execute.mock.calls.filter(([, query]) => query.includes('ORDER BY rowid'))).toHaveLength(
    1,
  );
});
