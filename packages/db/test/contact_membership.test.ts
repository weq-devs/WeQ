import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { fixtureDb, createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';
import { GroupMemberDb } from '../src/group_info/member';

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
