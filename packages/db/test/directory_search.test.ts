import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProfileInfoDb, RecentContactDb, GroupMemberDb, GroupDetailDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let root = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), 'weq-directory-search-'));
  const path = join(root, 'directory.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE buddy_list ("1000" TEXT, "1002" INTEGER);
    CREATE TABLE profile_info_v6 ("1000" TEXT, "1002" INTEGER, "20002" TEXT, "20009" TEXT, "20004" TEXT);
    CREATE TABLE recent_contact_v3_table ("40021" TEXT,"40030" INTEGER,"40010" INTEGER,"40094" TEXT,"41135" TEXT,"41148" TEXT,"40050" INTEGER);
    CREATE TABLE group_member3 ("60001" INTEGER,"1000" TEXT,"1002" INTEGER,"20002" TEXT,"64003" TEXT,"64016" INTEGER);
    CREATE TABLE group_list ("60001" INTEGER);
    CREATE TABLE group_detail_info_ver1 ("60001" INTEGER,"60007" TEXT,"60026" TEXT);`);
  const nt = createSqliteStub();
  return {
    sql,
    profiles: new ProfileInfoDb(nt, { dbPath: path }),
    recent: new RecentContactDb(nt, { dbPath: path }),
    members: new GroupMemberDb(nt, { dbPath: path }),
    groups: new GroupDetailDb(nt, { dbPath: path }),
  };
}

it('联系人包含非好友资料与缺少资料的好友，备注、号码和特殊字符按字面匹配', async () => {
  const f = fixture();
  f.sql.exec(`INSERT INTO buddy_list VALUES ('u_friend',10001),('u_no_profile',10002);
    INSERT INTO profile_info_v6 VALUES ('u_friend',10001,'好友','100%同学',NULL),
      ('u_history',10003,'历史联系人','原备注',NULL),('u_stranger',10004,'陌生人','100x同学',NULL);`);
  expect(await f.profiles.searchContacts('%')).toMatchObject([{ uid: 'u_friend', isFriend: true }]);
  expect(await f.profiles.searchContacts('历史')).toMatchObject([
    { uid: 'u_history', isFriend: false },
  ]);
  expect(await f.profiles.searchContacts('10002')).toMatchObject([
    { uid: 'u_no_profile', isFriend: true },
  ]);
  expect(await f.profiles.searchContacts('原备注')).toHaveLength(1);
  expect(await f.profiles.searchContacts(' ')).toEqual([]);
});

it('会话身份搜索包含临时会话的备注和群名片，不解析消息预览', async () => {
  const f = fixture();
  f.sql.exec(`INSERT INTO recent_contact_v3_table VALUES ('u_temp',10001,100,'昵称','备注','独有群名片',1),
    ('20001',0,2,'群聊','群备注','',2),('u_percent',10002,1,'100%off','','',3);`);
  expect(await f.recent.searchIdentities('独有群名片')).toMatchObject([
    { targetUid: 'u_temp', chatType: 100 },
  ]);
  expect(await f.recent.searchIdentities('群备注')).toMatchObject([
    { targetUid: '20001', chatType: 2 },
  ]);
  expect(await f.recent.searchIdentities('10001')).toHaveLength(1);
  expect(await f.recent.searchIdentities('%')).toMatchObject([{ targetUid: 'u_percent' }]);
});

it('群聊并集覆盖通讯录群、仅历史资料的群和缺少详情的通讯录群', async () => {
  const f = fixture();
  f.sql.exec(`INSERT INTO group_list VALUES (20001),(20003);
    INSERT INTO group_detail_info_ver1 VALUES (20001,'当前群','备注'),(20002,'历史群','100%群');`);
  expect(await f.groups.searchIdentities('群')).toMatchObject([
    { groupCode: '20001', inDirectory: true },
    { groupCode: '20002', inDirectory: false },
  ]);
  expect(await f.groups.searchIdentities('20003')).toMatchObject([
    { groupCode: '20003', inDirectory: true },
  ]);
  expect(await f.groups.searchIdentities('%')).toMatchObject([{ groupCode: '20002' }]);
});

it('新联系人来源可包含历史成员与群名片，旧群友接口仍只查在群昵称或号码', async () => {
  const f = fixture();
  f.sql.exec(`INSERT INTO group_member3 VALUES (20001,'u_left',10001,'昵称','独有名片',1),
    (20002,'u_current',10002,'昵称','当前名片',0);`);
  expect((await f.members.searchMembers('独有名片')).items).toEqual([]);
  expect((await f.members.searchMembers('昵称')).items).toHaveLength(1);
  expect(
    (
      await f.members.searchMembers('独有名片', -1, 0, {
        includeHistorical: true,
        includeCards: true,
      })
    ).items,
  ).toMatchObject([{ uid: 'u_left', card: '独有名片' }]);
});
