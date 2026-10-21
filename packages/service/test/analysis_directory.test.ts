import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AccountSession } from '@weq/account';
import { C2cMsgDb, GroupMsgDb, GroupMemberDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { BuddyAnalyticsService } from '../src/account/buddy_analytics';
import { GroupInfoService } from '../src/account/group_info';

let dir = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'weq-analysis-directory-'));
  const path = join(dir, 'msg.db');
  const sql = fixtureDb(path);
  for (const table of ['c2c_msg_table', 'group_msg_table']) {
    sql.exec(
      `CREATE TABLE ${table} ("40001" INTEGER,"40002" INTEGER,"40003" INTEGER,"40005" INTEGER,"40011" INTEGER,"40012" INTEGER,"40020" TEXT,"40021" TEXT,"40027" TEXT,"40030" INTEGER,"40033" INTEGER,"40050" INTEGER,"40062" BLOB,"40800" BLOB,"40801" BLOB)`,
    );
  }
  sql.exec(`INSERT INTO c2c_msg_table ("40021","40030") VALUES ('u_history',9007199254740993),('u_current',10002),('u_conflict',1),('u_conflict',2),('',0);
    INSERT INTO group_msg_table ("40001","40020","40033","40027","40050") VALUES
      (1,'u_old',10003,'777',100), (2,'',10003,'777',101), (3,'',10004,'777',102),
      (4,'',10005,'777',103), (5,'u_ghost',0,'777',104), (6,'u_old',10003,'888',100), (7,'',0,'777',100);
    CREATE TABLE group_member3 ("60001" INTEGER,"1000" TEXT,"1002" INTEGER,"20002" TEXT,"64003" TEXT,"64016" INTEGER);
    INSERT INTO group_member3 VALUES (777,'u_current',10002,'当前成员','',0),(777,'u_old',10003,'旧昵称','退群成员',1),(777,'',10004,'旧号','',1),(888,'u_other',10008,'别群成员','',0);`);
  const buddies = Array.from({ length: 2501 }, (_, i) => ({
    uid: i === 0 ? 'u_current' : `u_friend_${i}`,
    uin: BigInt(20000 + i),
  }));
  const session = {
    context: { uin: 10001 },
    uidMap: { sortNoByUid: () => undefined },
    c2cMsgs: new C2cMsgDb(createSqliteStub(), { dbPath: path }),
    groupMsgs: new GroupMsgDb(createSqliteStub(), { dbPath: path }),
    groupMembers: new GroupMemberDb(createSqliteStub(), { dbPath: path }),
    buddies: {
      listBuddies: async (limit: number, offset: number) => buddies.slice(offset, offset + limit),
    },
    profileInfo: {
      profilesByUids: async (uids: string[]) =>
        uids
          .filter((uid) => uid === 'u_history')
          .map((uid) => ({ uid, uin: 9007199254740993n, nick: '历史联系人', remark: '' })),
    },
    groupDetail: {
      listDirectory: async () => [{ groupCode: '999', memberCount: 0 }],
      listAll: async () => [{ groupCode: 777n, groupName: '缓存群', remark: '', memberCount: 1 }],
    },
  } as unknown as AccountSession;
  return {
    sql,
    session,
    buddy: new BuddyAnalyticsService(session),
    group: new GroupInfoService(session),
  };
}

it('私聊目录合并全部好友与消息分区，不截断末尾，不丢非好友或舍入 QQ 号', async () => {
  const { buddy, session } = fixture();
  const rows = await buddy.listAnalysisPeers();
  expect(rows).toHaveLength(2503);
  expect(rows.find((row) => row.uid === 'u_friend_2500')).toBeDefined();
  expect(rows.find((row) => row.uid === 'u_history')).toMatchObject({
    uid: 'u_history',
    uin: '9007199254740993',
    name: '历史联系人',
    source: 'messages',
    lastMessageTime: 0,
  });
  expect(rows.filter((row) => row.uid === 'u_current')).toHaveLength(1);
  expect(
    (await session.c2cMsgs.listPeerIdentities()).find((row) => row.uid === 'u_conflict')?.uin,
  ).toBe('');
});

it('冲突身份不按相同 QQ 号猜测唯一 UID，也不扩大 UID 分析范围', async () => {
  const { group, sql } = fixture();
  sql.exec(
    `INSERT INTO group_msg_table ("40020","40033","40027") VALUES ('u_conflict1',10006,'777'),('u_conflict2',10006,'777'),('',10006,'777')`,
  );
  const rows = await group.listAnalysisMembers(777n);
  expect(rows.find((row) => row.uid === 'u_conflict1')?.uin).toBe('');
  expect(rows.find((row) => row.uid === 'u_conflict2')?.uin).toBe('');
  expect(rows.find((row) => row.id === 'uin:10006')).toMatchObject({ uid: '', uin: '10006' });
  sql.exec(
    `INSERT INTO group_msg_table ("40020","40033","40027") VALUES ('u_two_numbers',10007,'777'),('u_two_numbers',10008,'777'),('',10007,'777')`,
  );
  const multiple = await group.listAnalysisMembers(777n);
  expect(multiple.find((row) => row.uid === 'u_two_numbers')?.uin).toBe('');
  expect(multiple.find((row) => row.id === 'uin:10007')).toMatchObject({ uid: '', uin: '10007' });
});

it('群和成员目录包含历史群、退群成员与名册外发言人，保留真实身份并隔离群', async () => {
  const { group } = fixture();
  // 群目录按最后一条消息时间倒序（与导出页同口径）：777 最新、888 次之、
  // 只在名册里出现过的 999 排最后。
  expect(await group.listAnalysisGroups()).toEqual([
    {
      groupCode: '777',
      groupName: '缓存群',
      memberCount: 1,
      source: 'directory',
      lastMessageTime: 104,
    },
    {
      groupCode: '888',
      groupName: '888',
      memberCount: 0,
      source: 'messages',
      lastMessageTime: 100,
    },
    { groupCode: '999', groupName: '999', memberCount: 0, source: 'directory', lastMessageTime: 0 },
  ]);
  const rows = await group.listAnalysisMembers(777n);
  expect(rows.find((row) => row.uid === 'u_old')).toMatchObject({
    id: 'uid:u_old',
    uin: '10003',
    name: '退群成员',
    source: 'directory',
  });
  expect(rows.find((row) => row.uin === '10004')).toMatchObject({
    id: 'uin:10004',
    uid: '',
    name: '旧号',
  });
  expect(rows.find((row) => row.uin === '10005')).toMatchObject({ uid: '', source: 'messages' });
  expect(rows.find((row) => row.uid === 'u_ghost')).toMatchObject({ source: 'messages' });
  expect(rows.some((row) => row.uid === 'u_other')).toBe(false);
  expect(rows.filter((row) => row.uin === '10003')).toHaveLength(1);
});

it('仅 QQ 号的成员不串入其他缺 UID 消息，同一真实身份可同时读取新旧消息', async () => {
  const { group } = fixture();
  const onlyNumber = await group.getGroupMemberAnalytics(777n, '', undefined, undefined, '10004');
  expect(onlyNumber.statistics.totalMessages).toBe(1);
  const mixed = await group.getGroupMemberAnalytics(777n, 'u_old', undefined, undefined, '10003');
  expect(mixed.statistics.totalMessages).toBe(2);
  expect(
    (await group.getGroupMemberAnalytics(888n, 'u_old', undefined, undefined, '10003')).statistics
      .totalMessages,
  ).toBe(1);
  await expect(group.getGroupMemberAnalytics(777n, '')).rejects.toThrow('身份不能为空');
  await expect(
    group.getGroupMemberAnalytics(777n, '', undefined, undefined, "10004' OR 1=1"),
  ).rejects.toThrow('QQ 号无效');
});
