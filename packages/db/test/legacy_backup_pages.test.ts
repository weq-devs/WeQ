import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { GroupMemberDb } from '../src/group_info/member';
import { GroupEssenceDb } from '../src/group_info/essence';
import { GroupExtDb } from '../src/group_info/ext';
import { GroupMemberLevelInfoDb } from '../src/group_info/member_level';
import { DeletedSessionDb } from '../src/contact/deleted_session';
import { FileAssistantDb } from '../src/file_assistant/file_assistant';
import { GroupDetailDb } from '../src/group_info/detail';
import { MiscDb } from '../src/profile/misc';

const dirs: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-legacy-pages-'));
  dirs.push(dir);
  const dbPath = join(dir, 'fixture.db');
  const sql = fixtureDb(dbPath);
  return { sql, nt: createSqliteStub(), opts: { dbPath } };
}

it('旧群成员无头衔和等级列时，列表、搜索、单人查询仍读取真实成员', async () => {
  const { sql, nt, opts } = fixture();
  sql.exec(`CREATE TABLE group_member3 (
    "60001" INTEGER, "1000" TEXT, "1002" INTEGER, "64003" TEXT, "20002" TEXT,
    "64007" INTEGER, "64008" INTEGER, "64009" INTEGER, "64010" INTEGER, "64016" INTEGER);
    CREATE TABLE group_detail_info_ver1 ("60001" INTEGER, "60002" TEXT);
    INSERT INTO group_member3 VALUES (777,'u_member',12345,'旧名片','旧昵称',10,20,0,0,0)`);
  const db = new GroupMemberDb(nt, opts);
  const expected = { uid: 'u_member', customTitle: '', memberLevel: 0, card: '旧名片' };
  expect((await db.listMembersInGroup(777n))[0]).toMatchObject(expected);
  expect((await db.listMembersByLevel(777n))[0]).toMatchObject(expected);
  expect((await db.searchMembersInGroup(777n, '旧')).items[0]).toMatchObject(expected);
  expect(await db.getMember(777n, 'u_member')).toMatchObject(expected);
  expect((await db.getMembersByUids(777n, ['u_member']))[0]).toMatchObject(expected);
  expect((await db.getMembersByUins(777n, [12345n]))[0]).toMatchObject(expected);
  expect((await db.listMemberBriefsInGroup(777n))[0]?.memberLevel).toBe(0);
  expect((await db.listMemberJoinBriefs(777n))[0]?.memberLevel).toBe(0);
  expect((await db.listUserGroups('u_member'))[0]).toMatchObject(expected);
  expect(await db.listLeftMembersInGroup(777n)).toEqual([]);
});

it('旧备份没有可选功能表时返回空结果，不阻断群资料和会话列表', async () => {
  const { sql, nt, opts } = fixture();
  sql.exec('CREATE TABLE unrelated (id INTEGER)');
  const essence = new GroupEssenceDb(nt, opts);
  expect(await essence.listEssence(777n)).toEqual([]);
  expect(await essence.listEssenceSeqs(777n)).toEqual([]);
  expect(await new GroupExtDb(nt, opts).getExt(777n)).toBeNull();
  expect(await new GroupExtDb(nt, opts).listAll()).toEqual([]);
  expect(await new GroupMemberLevelInfoDb(nt, opts).getLevelInfo(777n)).toBeNull();
  expect(await new DeletedSessionDb(nt, opts).listDeletedSessions()).toEqual([]);
  expect(await new MiscDb(nt, opts).getUserOnlineStatus('u_member')).toBeNull();
});

it('旧群资料缺退群标记时不能把列号 60340 当成真实退群状态', async () => {
  const { sql, nt, opts } = fixture();
  sql.exec(`CREATE TABLE group_detail_info_ver1 ("60001" INTEGER, "60007" TEXT, "60216" TEXT,
    "60217" TEXT, "60026" TEXT, "60002" TEXT, "60004" INTEGER, "60005" INTEGER,
    "60006" INTEGER, "60218" TEXT, "60224" TEXT, "60241" BLOB, "60242" BLOB);
    INSERT INTO group_detail_info_ver1 ("60001", "60007") VALUES (777, '旧群');
    CREATE TABLE group_list ("60001" INTEGER, "60018" INTEGER, "60022" INTEGER, "60006" INTEGER);
    INSERT INTO group_list VALUES (777,2,0,10)`);
  const db = new GroupDetailDb(nt, opts);
  expect(await db.getDetail(777n)).toMatchObject({ groupName: '旧群', leaveFlag: 0 });
  expect((await db.listDirectory())[0]).toMatchObject({
    groupCode: '777',
    notifyLevel: 0,
    unnamed: false,
  });
});

it('只有 v1 文件表时仍能按消息查找文件，而不是先查 v2 报错', async () => {
  const { sql, nt, opts } = fixture();
  sql.exec(`CREATE TABLE file_assistant ("200002" TEXT, "200001" TEXT, "200016" INTEGER,
    "200005" INTEGER, "200009" INTEGER, "1000" TEXT, "40021" TEXT, "200011" TEXT);
    INSERT INTO file_assistant VALUES ('sample.jpg','abc',101,16,1000,'u_sender','u_peer','/old/sample.jpg')`);
  const db = new FileAssistantDb(nt, opts);
  expect(await db.getByMsgId(100n)).toMatchObject({
    fileName: 'sample.jpg',
    sourceTable: 'file_assistant',
  });
  expect(await db.listAll()).toHaveLength(1);
});

it('存在但结构错误的表不能被兼容路径吞成空数据', async () => {
  const { sql, nt, opts } = fixture();
  sql.exec('CREATE TABLE group_member3 (wrong TEXT); CREATE TABLE file_assistant (wrong TEXT)');
  await expect(new GroupMemberDb(nt, opts).listMembersInGroup(777n)).rejects.toThrow();
  // 读取错误必须保留，不能再把所有 SQL 异常解释成旧版本缺表。
  const broken = new FileAssistantDb(
    {
      ...nt,
      executeSql: async () => {
        throw new Error('database disk image is malformed');
      },
    },
    opts,
  );
  await expect(broken.listAll()).rejects.toThrow('malformed');
});
