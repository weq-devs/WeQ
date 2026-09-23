/**
 * `GroupMemberDb.searchMembersInGroup` —— 群资料面板「搜群成员」的离线回归。
 *
 * 面板以前只在**已加载的成员分页**里做客户端过滤（排在后面几页的成员搜不到，
 * 而且过滤后列表短于容器时连「加载更多」都触发不了）。这条 SQL 就是修好它的
 * 地基，所以在一个 SQLite fixture 上锁住四件事：
 *
 *  - 匹配口径：群名片 / 昵称 / QQ 号都能命中；
 *  - 作用域：只搜本群，别的群里的同名成员不能串进来；
 *  - 退群过滤：64016 = 1 的成员不算（与 listMembersInGroup 同规则）；
 *  - 翻页：LIMIT/OFFSET 按全局有序的 card→nick→uid 切，不重不漏，total 是
 *    全部匹配数（不是本页条数）；关键字里的 `%` / `_` 按字面量匹配。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupMemberDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const GROUP = 777n;
const OTHER_GROUP = 888n;

let dir: string;
let db: GroupMemberDb;

afterEach(() => {
  db.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

/** 一行成员：uid / uin / 群名片 / 昵称 / 是否已退群（64016）。 */
type Row = [uid: string, uin: number, card: string, nick: string, left?: boolean];

function createFixture(rows: Row[], groupCode = GROUP): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-member-search-'));
  const dbPath = join(dir, 'group_info.db');
  const sql = fixtureDb(dbPath);
  sql.exec(
    `CREATE TABLE group_member3 ("60001" INTEGER, "1000" TEXT, "1002" INTEGER, "64003" TEXT,
      "20002" TEXT, "64007" INTEGER, "64008" INTEGER, "64009" INTEGER, "64010" INTEGER,
      "64016" INTEGER, "64023" TEXT, "64035" INTEGER)`,
  );
  const insert = sql.prepare(
    `INSERT INTO group_member3
      ("60001","1000","1002","64003","20002","64007","64008","64009","64010","64016","64023","64035")
     VALUES (?,?,?,?,?,0,0,0,0,?,'',0)`,
  );
  for (const [uid, uin, card, nick, left] of rows) {
    insert.run(groupCode, uid, uin, card, nick, left ? 1 : 0);
  }
  db = new GroupMemberDb(createSqliteStub(), { dbPath });
}

/** 搜到的 uid 列表，按返回顺序。 */
async function searchUids(keyword: string, limit = 30, offset = 0, groupCode = GROUP) {
  const { items, total } = await db.searchMembersInGroup(groupCode, keyword, limit, offset);
  return { uids: items.map((m) => m.uid), total };
}

const ROWS: Row[] = [
  // 群名片命中。
  ['u_a', 10001, '阿狸', 'Alice'],
  // 昵称命中（没有群名片）。
  ['u_b', 10002, '', 'Bob'],
  // 已退群：昵称能对上，但不该被搜出来。
  ['u_c', 10003, '', 'Carol', true],
  // 关键字里的 % / _ 必须按字面量匹配。
  ['u_percent', 10004, '', '100%off'],
  ['u_under', 10005, '', 'a_b'],
  ['u_under2', 10006, '', 'axb'],
  // 翻页用：同一关键字命中三行，卡片名保证全局有序。
  ['u_t0', 10007, '测试0', 'T0'],
  ['u_t1', 10008, '测试1', 'T1'],
  ['u_t2', 10009, '测试2', 'T2'],
];

function fixtureWithOtherGroup(): void {
  createFixture(ROWS);
  // 同名的另一个群成员：搜 777 时不能出现。
  const sql = fixtureDb(join(dir, 'group_info.db'));
  sql
    .prepare(
      `INSERT INTO group_member3
        ("60001","1000","1002","64003","20002","64007","64008","64009","64010","64016","64023","64035")
       VALUES (?,?,?,?,?,0,0,0,0,0,'',0)`,
    )
    .run(OTHER_GROUP, 'u_other', 99999, '阿狸', 'Alice-other');
}

describe('GroupMemberDb.searchMembersInGroup (offline fixture)', () => {
  it('matches group card, and stays scoped to one group', async () => {
    fixtureWithOtherGroup();

    expect(await searchUids('阿狸')).toEqual({ uids: ['u_a'], total: 1 });
    expect(await searchUids('阿狸', 30, 0, OTHER_GROUP)).toEqual({
      uids: ['u_other'],
      total: 1,
    });
  });

  it('matches nick and QQ number', async () => {
    createFixture(ROWS);

    expect(await searchUids('Bob')).toEqual({ uids: ['u_b'], total: 1 });
    expect(await searchUids('10002')).toEqual({ uids: ['u_b'], total: 1 });
  });

  it('skips members who left the group (64016 = 1)', async () => {
    createFixture(ROWS);

    expect(await searchUids('Carol')).toEqual({ uids: [], total: 0 });
  });

  it('trims the keyword and returns nothing for an empty one', async () => {
    createFixture(ROWS);

    expect(await searchUids('  阿狸  ')).toEqual({ uids: ['u_a'], total: 1 });
    expect(await searchUids('   ')).toEqual({ uids: [], total: 0 });
  });

  it('treats % and _ in the keyword as literals, not wildcards', async () => {
    createFixture(ROWS);

    // 没转义时 `%` 会命中整张表，`a_b` 会连 `axb` 一起吞掉。
    expect(await searchUids('%')).toEqual({ uids: ['u_percent'], total: 1 });
    expect(await searchUids('a_b')).toEqual({ uids: ['u_under'], total: 1 });
    expect(await searchUids('axb')).toEqual({ uids: ['u_under2'], total: 1 });
  });

  it('pages matches without skipping or repeating, and reports the full total', async () => {
    createFixture(ROWS);

    const first = await searchUids('测试', 2, 0);
    expect(first).toEqual({ uids: ['u_t0', 'u_t1'], total: 3 });

    const second = await searchUids('测试', 2, 2);
    expect(second).toEqual({ uids: ['u_t2'], total: 3 });
  });
});
