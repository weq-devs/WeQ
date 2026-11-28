import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { GroupMsgDb } from '../src/msg/group';
import { withRecordedGroupSenderNames } from '../src/msg/group_sender_history';
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

it('退群行可以按 UID 和 QQ 号回读，但不进入当前成员分页', async () => {
  const { sql, nt, opts } = fixture();
  sql.exec(`CREATE TABLE group_member3 (
    "60001" INTEGER, "1000" TEXT, "1002" INTEGER, "64003" TEXT, "20002" TEXT,
    "64007" INTEGER, "64008" INTEGER, "64009" INTEGER, "64010" INTEGER, "64016" INTEGER);
    CREATE TABLE group_detail_info_ver1 ("60001" INTEGER, "60002" TEXT);
    INSERT INTO group_member3 VALUES (777,'u_member',12345,'旧名片','旧昵称',10,20,0,0,1),
      (778,'u_member',12345,'另一个群的名片','旧昵称',10,20,0,0,0)`);
  const db = new GroupMemberDb(nt, opts);
  expect(await db.listMembersInGroup(777n)).toEqual([]);
  const left = await db.listLeftMembersInGroup(777n);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatchObject({ uid: 'u_member', uin: 12345n, card: '旧名片', memberFlag: 1 });
  expect(await db.getMembersByUids(777n, ['u_member'])).toEqual(left);
  expect(await db.getMembersByUins(777n, [12345n])).toEqual(left);
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

it.each([false, true])('群消息历史称呼与旧表兼容（有历史字段 %s）', async (hasNames) => {
  const { sql, nt, opts } = fixture();
  sql.exec(`CREATE TABLE group_msg_table (
    "40001" INTEGER PRIMARY KEY, "40002" INTEGER, "40003" INTEGER, "40011" INTEGER,
    "40012" INTEGER, "40020" TEXT, "40027" TEXT, "40033" INTEGER,
    "40050" INTEGER, "40062" BLOB, "40800" BLOB, "40801" BLOB
    ${hasNames ? ', "40090" TEXT, "40093" TEXT' : ''});
    INSERT INTO group_msg_table VALUES (9007199254740993,0,0,2,0,'u_a','777',11111,10,NULL,NULL,NULL
      ${hasNames ? ",' 旧称呼 ',NULL" : ''});`);
  if (hasNames)
    sql.exec(`INSERT INTO group_msg_table VALUES
    (9007199254740994,0,2,2,0,'u_a','777',11111,20,NULL,NULL,NULL,'旧称呼',NULL),
    (9007199254740995,0,3,2,0,'u_a','777',11111,22,NULL,NULL,NULL,'','旧昵称'),
    (9007199254740996,0,4,2,0,'u_b','777',22222,21,NULL,NULL,NULL,'旧称呼',NULL),
    (9007199254740997,0,5,2,0,'u_a','888',11111,24,NULL,NULL,NULL,'另一个群的称呼',NULL),
    (9007199254740998,0,6,5,0,'u_a','777',11111,25,NULL,NULL,NULL,'灰条上的名字',NULL);`);
  const statements: string[] = [];
  const db = new GroupMsgDb(
    {
      ...nt,
      async executeSql(...args) {
        statements.push(args[1]);
        return nt.executeSql(...args);
      },
    },
    opts,
  );
  try {
    expect((await db.listByMsgIds([9007199254740993n]))[0]?.senderAtTime).toBeUndefined();
    await db.listNewestHistory('777', 10);
    await db.browse('777', {});
    await db.exportSourceRows('777', ['9007199254740993'], false);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((sql) => !/40090|40093|pragma_table_info/.test(sql))).toBe(true);
    expect(await db.recordedSenderNames('777', ['9007199254740993'])).toEqual(
      hasNames ? [{ msgId: '9007199254740993', sender: { name: '旧称呼', kind: 'display' } }] : [],
    );
    expect(await db.recordedSenderNames('888', ['9007199254740993'])).toEqual([]);
    const matches = await db.senderNames({
      groupCode: '777',
      keyword: '旧称呼',
      limit: 10,
      distinctSenders: true,
    });
    if (!hasNames) {
      expect(matches).toEqual([]);
      expect((await db.browse('777', {}))[0]?.message.senderAtTime).toBeUndefined();
      return;
    }
    expect(matches.map((row) => row.senderUid)).toEqual(['u_b', 'u_a']);
    expect(matches[1]).toMatchObject({
      first: { msgId: '9007199254740993', msgSeq: '0' },
      last: { msgId: '9007199254740994', msgSeq: '2' },
    });
    const aliases = await db.senderNames({ senderUid: 'u_a', limit: 10 });
    expect(aliases.map(({ groupCode, kind, name }) => [groupCode, kind, name])).toEqual([
      ['888', 'display', '另一个群的称呼'],
      ['777', 'nickname', '旧昵称'],
      ['777', 'display', '旧称呼'],
    ]);
    const exported = await withRecordedGroupSenderNames(() =>
      db.exportSourceRows('777', ['9007199254740995'], false),
    );
    expect(exported[0]?.message.senderAtTime).toEqual({ name: '旧昵称', kind: 'nickname' });
    const [regular, historical] = await Promise.all([
      db.listAfter('777', 1n),
      withRecordedGroupSenderNames(() => db.listAfter('777', 1n)),
    ]);
    expect(regular.every((row) => row.senderAtTime === undefined)).toBe(true);
    expect(historical[0]?.senderAtTime?.name).toBe('旧称呼');
  } finally {
    db.close();
  }
});

it('历史称呼索引先返回可用结果，索引可以复用并接续新增消息', async () => {
  const { sql, nt, opts } = fixture();
  sql.exec(`CREATE TABLE group_msg_table (
    "40001" INTEGER PRIMARY KEY, "40003" INTEGER, "40011" INTEGER,
    "40020" TEXT, "40027" TEXT, "40033" INTEGER, "40050" INTEGER, "40090" TEXT, "40093" TEXT);
    INSERT INTO group_msg_table VALUES (1,1,2,'u_speaker','777',10001,10,'旧称呼',NULL);`);
  let indexPathReads = 0;
  const config = {
    ...opts,
    senderNameIndexPath: () => {
      indexPathReads++;
      return opts.dbPath + '.names.sqlite';
    },
  };
  const filter = { keyword: '称呼', distinctSenders: true, limit: 10 };
  const first = new GroupMsgDb(nt, config);
  try {
    expect(await first.senderNames({ ...filter, groupCode: '777' })).toMatchObject([
      { name: '旧称呼' },
    ]);
    expect(indexPathReads).toBe(0);
    const reader = new AbortController();
    const request = first.senderNames({ ...filter, signal: reader.signal });
    reader.abort();
    await expect(request).resolves.toEqual([]);
    await expect.poll(() => first.senderNamesPending).toBe(false);
    expect(await first.senderNames(filter)).toEqual([]);
    expect(first.senderNamesPending).toBe(true);
    await expect.poll(() => first.senderNamesPending).toBe(false);
    expect(await first.senderNames(filter)).toMatchObject([
      { name: '旧称呼', last: { msgId: '1' } },
    ]);
  } finally {
    first.close();
  }
  fixtureDb(opts.dbPath).exec(
    `INSERT INTO group_msg_table VALUES (2,2,2,'u_speaker','777',10001,20,'新称呼',NULL)`,
  );
  const reopened = new GroupMsgDb(nt, config);
  try {
    expect(await reopened.senderNames(filter)).toMatchObject([{ name: '旧称呼' }]);
    await expect.poll(async () => (await reopened.senderNames(filter))[0]?.name).toBe('新称呼');
    expect(await reopened.senderNames({ senderUid: 'u_speaker', limit: 10 })).toMatchObject([
      { name: '新称呼' },
      { name: '旧称呼' },
    ]);
  } finally {
    reopened.close();
  }
});
