import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupDetailDb } from '../src/group_info/detail';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let dir: string;
let db: GroupDetailDb;
afterEach(() => {
  db?.close();
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('current QQ group directory', () => {
  it('reads roles, counts and current membership independently of member and historical caches', async () => {
    dir = mkdtempSync(join(tmpdir(), 'weq-group-directory-'));
    const dbPath = join(dir, 'group_info.db');
    const sql = fixtureDb(dbPath);
    sql.exec(`CREATE TABLE group_list (
      "60001" INTEGER, "60018" INTEGER, "60022" INTEGER, "60252" INTEGER,
      "60281" INTEGER, "60006" INTEGER);
      INSERT INTO group_list VALUES (10001,4,1,1,0,10),(10002,3,0,2,1,40),
        (10003,2,0,3,1,1008),(10004,0,0,1,NULL,0);
      CREATE TABLE group_detail_info_ver1 ("60001" INTEGER,"60006" INTEGER);
      INSERT INTO group_detail_info_ver1 VALUES (10009,1);`);
    db = new GroupDetailDb(createSqliteStub(), { dbPath });
    expect(await db.listDirectory()).toEqual([
      {
        groupCode: '10001',
        role: 'owner',
        pinned: true,
        notifyLevel: 1,
        unnamed: true,
        memberCount: 10,
      },
      {
        groupCode: '10002',
        role: 'admin',
        pinned: false,
        notifyLevel: 2,
        unnamed: false,
        memberCount: 40,
      },
      {
        groupCode: '10003',
        role: 'member',
        pinned: false,
        notifyLevel: 3,
        unnamed: false,
        memberCount: 1008,
      },
      {
        groupCode: '10004',
        role: null,
        pinned: false,
        notifyLevel: 1,
        unnamed: false,
        memberCount: 0,
      },
    ]);
  });
});
