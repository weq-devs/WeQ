import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createSqliteStub } from '@weq/testkit';
import { BuddyDb } from '../src/profile/buddy';
import { ProfileInfoDb } from '../src/profile/profile_info';
import { GroupMemberDb } from '../src/group_info/member';

it.each([true, false])('联系人数据库提供可用于文件监听的实际路径（共用资料库：%s）', (shared) => {
  const nt = createSqliteStub();
  const profilePath = resolve('fixtures/profile_info.db');
  const buddyPath = shared ? profilePath : resolve('fixtures/buddy.db');
  const groupPath = resolve('fixtures/group_info.db');
  const databases = [
    new ProfileInfoDb(nt, { dbPath: profilePath }),
    new BuddyDb(nt, { dbPath: buddyPath }),
    new GroupMemberDb(nt, { dbPath: groupPath }),
  ];

  expect(databases.map((db) => resolve(db.dbPath))).toEqual([profilePath, buddyPath, groupPath]);
  expect(new Set(databases.map((db) => db.dbPath)).size).toBe(shared ? 2 : 3);
});
