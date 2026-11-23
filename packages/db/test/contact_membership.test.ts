import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { fixtureDb, createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';
import { GroupMemberDb } from '../src/group_info/member';
import { databasePerformance } from '../src/query_schedule';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('成员摘要按 UID 去重，排除退群和空身份，完整覆盖超过一批的好友', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-contact-members-'));
  roots.push(root);
  const path = join(root, 'group_info.db'),
    sql = fixtureDb(path);
  sql.exec('CREATE TABLE group_member3 ("60001" INTEGER, "1000" TEXT, "64016" INTEGER)');
  const insert = sql.prepare('INSERT INTO group_member3 VALUES (?, ?, ?)');
  insert.run(100, 'u_friend', 0);
  insert.run(100, 'u_friend', 0);
  insert.run(100, 'u_other', null);
  insert.run(100, 'u_left', 1);
  insert.run(100, '', 0);
  insert.run(100, '0', 0);
  insert.run(100, 'u_invalid!', 0);
  insert.run(200, 'u_friend', 0);
  const db = new GroupMemberDb(createSqliteStub(), { dbPath: path });
  const result = await db.contactMembershipSnapshot([
    ...Array.from({ length: 405 }, (_, i) => `u_unused_${i}`),
    'u_friend',
    'u_left',
    'u_friend',
  ]);
  expect(result.get('100')).toEqual({ total: 2, friends: new Set(['u_friend']) });
  expect(result.get('200')).toEqual({ total: 1, friends: new Set(['u_friend']) });
  expect((await db.contactMembershipSnapshot([])).get('100')).toEqual({
    total: 2,
    friends: new Set(),
  });
});

it('按索引汇总指定群，和行页路径有相同的成员计数与好友集合', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-contact-members-'));
  roots.push(root);
  const path = join(root, 'group_info.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE group_member3 ("60001" INTEGER, "1000" TEXT, "64016" INTEGER);
    CREATE INDEX membership_group ON group_member3 ("60001", "1000");`);
  const insert = sql.prepare('INSERT INTO group_member3 VALUES (?, ?, ?)');
  for (let group = 1; group <= 25; group++) {
    insert.run(group, 'u_friend', 0);
    insert.run(group, 'u_friend', null);
    insert.run(group, 'u_left', 1);
    insert.run(group, 'u_other-A_0', 0);
    insert.run(group, 'u_', 0);
    insert.run(group, 'u_invalid!', 0);
  }
  insert.run(99, 'u_left', 1);
  const codes = [...Array.from({ length: 20 }, (_, i) => String(i + 1)), '99', '100', '1'];
  const db = new GroupMemberDb(createSqliteStub(), { dbPath: path });
  const friends = ['u_friend', 'u_friend', 'u_left'];
  const before = await db.contactMembershipSnapshot(friends);
  const expected = new Map([...before].filter(([group]) => codes.includes(group)));
  expect(expected.size).toBe(20);
  expect(expected.get('1')).toEqual({ total: 2, friends: new Set(['u_friend']) });
  expect(await db.contactMembershipSnapshot(friends, codes)).toEqual(expected);
  expect(await db.contactMembershipSnapshot(friends, [])).toEqual(new Map());

  // 旧备份中空白字符串经 Number 转换等于零，仍按原行为计入。
  insert.run(1, 'u_old_flag', ' ');
  const rowsBefore = databasePerformance(path).returnedRows;
  const withLegacy = await db.contactMembershipSnapshot(friends, ['1', '2']);
  const transferred = databasePerformance(path).returnedRows - rowsBefore;
  expect(withLegacy.get('1')).toEqual({ total: 3, friends: new Set(['u_friend']) });
  expect(withLegacy.get('2')).toEqual(expected.get('2'));
  expect(transferred).toBeLessThan(20);
});
