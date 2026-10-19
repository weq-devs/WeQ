import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RecentContactDb, ProfileInfoDb, GroupMemberDb } from '@weq/db';
import { ChatType } from '@weq/codec';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let root = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});

it('会话按精确、前缀、包含排序，同档按时间，分页保持稳定', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-search-order-'));
  const path = join(root, 'nt_msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE recent_contact_v3_table (
    "40003" INTEGER, "40010" INTEGER, "40020" TEXT, "40021" TEXT, "40030" INTEGER,
    "40050" INTEGER, "40051" BLOB, "40090" TEXT, "40093" TEXT, "40094" TEXT,
    "40095" TEXT, "41110" TEXT, "41135" TEXT, "41148" TEXT, "41220" INTEGER,
    "60001" INTEGER, "41103" INTEGER, "41104" INTEGER)`);
  const insert = sql.prepare(`INSERT INTO recent_contact_v3_table
    ("40010", "40021", "40094", "40050") VALUES (?, ?, ?, ?)`);
  insert.run(ChatType.KCHATTYPEC2C, 'contains', 'xNeedle', 100);
  insert.run(ChatType.KCHATTYPEC2C, 'prefix', 'Needle x', 10);
  insert.run(ChatType.KCHATTYPEC2C, 'exact', 'needle', 1);
  const db = new RecentContactDb(createSqliteStub(), { dbPath: path });
  expect((await db.searchByName('Needle', 1)).items.map((row) => row.targetUid)).toEqual(['exact']);
  expect((await db.searchByName('Needle', 2, 1)).items.map((row) => row.targetUid)).toEqual([
    'prefix',
    'contains',
  ]);
});

it('好友与全局群友在分页前按昵称或号码相关度排序，通配符按字面量处理', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-people-order-'));
  const path = join(root, 'people.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE buddy_list ("1000" TEXT, "1002" INTEGER);
    CREATE TABLE profile_info_v6 ("1000" TEXT, "20002" TEXT, "20009" TEXT, "20004" TEXT);
    CREATE TABLE group_member3 ("60001" INTEGER, "1000" TEXT, "1002" INTEGER,
      "20002" TEXT, "64003" TEXT, "64016" INTEGER)`);
  for (const [uid, nick, uin] of [
    ['a', 'xNeedle', 111],
    ['b', 'Needle next', 222],
    ['c', 'needle', 333],
    ['d', '100%off', 444],
  ] as const) {
    sql.prepare('INSERT INTO buddy_list VALUES (?, ?)').run(uid, uin);
    sql.prepare('INSERT INTO profile_info_v6 VALUES (?, ?, ?, ?)').run(uid, nick, '', '');
    sql.prepare('INSERT INTO group_member3 VALUES (1, ?, ?, ?, ?, 0)').run(uid, uin, nick, '');
  }
  const nt = createSqliteStub();
  const friends = new ProfileInfoDb(nt, { dbPath: path });
  const members = new GroupMemberDb(nt, { dbPath: path });
  for (const search of [friends.searchFriends.bind(friends), members.searchMembers.bind(members)]) {
    expect((await search('Needle', 1)).items.map((row) => row.uid)).toEqual(['c']);
    expect((await search('Needle', 2, 1)).items.map((row) => row.uid)).toEqual(['b', 'a']);
    expect((await search('333', 1)).items.map((row) => row.uid)).toEqual(['c']);
    expect((await search('%', 10)).items.map((row) => row.uid)).toEqual(['d']);
  }
});
