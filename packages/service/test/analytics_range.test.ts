import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { C2cMsgDb, GroupMsgDb } from '@weq/db';
import type { AccountSession } from '@weq/account';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { BuddyAnalyticsService } from '../src/account/buddy_analytics';
import { GroupInfoService } from '../src/account/group_info';
import { analyticsDayParts, validateAnalyticsRange } from '../src/common/analytics_time';

let root = '';
afterEach(() => {
  vi.restoreAllMocks();
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
const start = Date.parse('2026-10-18T00:00:00+08:00') / 1000;
const rows = 2502;
const hugeRows = 2001;

it('所选消息按精确 ID 分析，同秒未选消息与其他会话不能混入统计', async () => {
  const { buddy, group } = fixture();
  const scope = { messageIds: ['1', '4', '7000'] };
  const privateReport = await buddy.getBuddyAnalytics('u_peer', scope);
  expect(privateReport.statistics.totalMessages).toBe(2);
  expect(privateReport.timeline.daily).toEqual([{ date: '2026-10-18', count: 2 }]);
  const report = await group.getGroupStatsReport(777n, scope);
  expect(report.totals.totalMessages).toBe(2);
  expect(report.timeline.daily).toEqual([{ date: '2026-10-18', count: 2 }]);
  expect((await group.getGroupConversationGraph(777n, scope)).messageCount).toBe(2);
  expect(
    (
      await group.getGroupMemberAnalytics(
        777n,
        'u_peer',
        undefined,
        undefined,
        undefined,
        scope.messageIds,
      )
    ).statistics.totalMessages,
  ).toBe(1);
  expect((await group.getGroupJoinBatches(777n, scope)).groupMessageTotal).toBe(2);
  expect(
    (await buddy.getBuddyAnalytics('u_peer', { messageIds: [] })).statistics.totalMessages,
  ).toBe(0);
  expect((await group.getGroupStatsReport(777n, { messageIds: [] })).totals.totalMessages).toBe(0);
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'weq-analytics-'));
  const path = join(root, 'msg.db'),
    sql = fixtureDb(path);
  for (const table of ['c2c_msg_table', 'group_msg_table']) {
    sql.exec(
      `CREATE TABLE ${table} ("40001" INTEGER,"40002" INTEGER,"40003" INTEGER,"40005" INTEGER,"40011" INTEGER,"40012" INTEGER,"40020" TEXT,"40021" TEXT,"40027" TEXT,"40030" INTEGER,"40033" INTEGER,"40050" INTEGER,"40062" BLOB,"40800" BLOB,"40801" BLOB)`,
    );
    const add = sql.prepare(
      `INSERT INTO ${table} ("40001","40003","40020","40021","40027","40050") VALUES(?,?,?,?,?,?)`,
    );
    sql.exec('BEGIN');
    add.run(-1, 0, 'u_peer', 'u_peer', '777', start - 1);
    for (let i = 0; i < rows; i++)
      add.run(i + 1, 1, i % 2 ? 'u_peer' : 'u_self', 'u_peer', '777', start);
    add.run(6000, 0, 'u_peer', 'u_peer', '777', start + 86400);
    add.run(6001, null, 'u_self', 'u_peer', '777', null);
    add.run(7000, 2, 'u_other', 'u_other', '999', start);
    add.run(8000, 3, 'u_self', 'u_ordered', '999', start + 5);
    add.run(8001, 1, 'u_ordered', 'u_ordered', '999', start + 2);
    for (let i = 0; i < hugeRows; i++)
      add.run(9000 + i, 0, 'u_huge', 'u_huge', '555', 9007199254740993n);
    sql.exec('COMMIT');
  }
  const session = {
    context: { uin: 10001 },
    uidMap: { sortNoByUid: () => undefined },
    c2cMsgs: new C2cMsgDb(createSqliteStub(), { dbPath: path }),
    groupMsgs: new GroupMsgDb(createSqliteStub(), { dbPath: path }),
    groupMembers: {
      getMembersByUids: async (_group: bigint, uids: string[]) =>
        uids.map((uid) => ({
          uid,
          uin: uid === 'u_peer' ? 10002n : 10001n,
          card: uid,
          nick: '',
        })),
      listMemberJoinBriefs: async () =>
        ['u_self', 'u_peer', 'u_third', 'u_old1', 'u_old2', 'u_old3'].map((uid, i) => ({
          uid,
          uin: '',
          card: uid,
          nick: '',
          joinTime: i < 3 ? start + i * 10 : start - 7200 + i,
          lastSpeakTime: 0,
          memberLevel: 1,
        })),
    },
    groupDetail: { getDetail: async () => ({ memberCount: 6 }) },
  } as unknown as AccountSession;
  return {
    session,
    buddy: new BuddyAnalyticsService(session),
    group: new GroupInfoService(session),
  };
}

it('异常大整数时间保持精确游标，跨页不会循环或伪造有效日期', async () => {
  const { session, buddy, group } = fixture();
  let pages = 0;
  const read = session.c2cMsgs.browse.bind(session.c2cMsgs);
  vi.spyOn(session.c2cMsgs, 'browse').mockImplementation(
    (part, filter, cursor, limit, direction) => {
      if (++pages > 10) throw new Error('分页没有结束');
      if (cursor) expect(typeof cursor.time).toBe('bigint');
      return read(part, filter, cursor, limit, direction);
    },
  );
  const result = await buddy.getBuddyAnalytics('u_huge');
  expect(result.statistics.totalMessages).toBe(hugeRows);
  expect(result.daily).toEqual([]);
  const timeline = session.groupMsgs.browseSenderTimeline.bind(session.groupMsgs);
  vi.spyOn(session.groupMsgs, 'browseSenderTimeline').mockImplementation(
    (conv, filter, cursor, limit) => {
      if (++pages > 15) throw new Error('时间线分页没有结束');
      if (cursor) expect(typeof cursor.time).toBe('bigint');
      return timeline(conv, filter, cursor, limit);
    },
  );
  expect((await group.getGroupConversationGraph(555n)).messageCount).toBe(0);
});

it('好友统计按北京时间与闭区间读取全部同序号记录，不将范围外消息算进回复或发起', async () => {
  const { buddy } = fixture();
  const result = await buddy.getBuddyAnalytics('u_peer', { startTime: start, endTime: start });
  expect(result.statistics).toMatchObject({
    totalMessages: rows,
    selfMessages: rows / 2,
    peerMessages: rows / 2,
    activeDays: 1,
    firstMessageTime: start,
    lastMessageTime: start,
  });
  expect(result.daily).toEqual([{ date: '2026-10-18', count: rows }]);
  expect(result.timeline.daily).toEqual([
    { date: '2026-10-17', count: 1 },
    { date: '2026-10-18', count: rows },
    { date: '2026-10-19', count: 1 },
  ]);
  expect(result.weeklySelf.reduce((sum, count) => sum + count, 0)).toBe(rows / 2);
  expect(result.hourlySelf[0]).toBe(rows / 2);
  expect(result.initiation).toEqual({ self: 1, peer: 0, total: 1 });
  expect(result.reply.peer?.count).toBe(rows / 2);
  expect(result.reply.self?.count).toBe(rows / 2 - 1);
  expect(result.streak).toEqual({ longest: 1, current: 1 });
  expect((await buddy.getBuddyAnalytics('u_peer')).statistics.totalMessages).toBe(rows + 3);
  expect(
    (await buddy.getBuddyAnalytics('u_peer', { startTime: start + 1, endTime: start + 2 }))
      .statistics.totalMessages,
  ).toBe(0);
  expect(
    (await buddy.getBuddyAnalytics('u_peer', { startTime: 0, endTime: 0 })).statistics
      .totalMessages,
  ).toBe(0);
  const ordered = await buddy.getBuddyAnalytics('u_ordered');
  expect(ordered.initiation).toEqual({ self: 0, peer: 1, total: 1 });
  expect(ordered.reply.self).toMatchObject({ fastestSec: 3, slowestSec: 3, count: 1 });
});

it('群画像、成员、入群批次与会话力图沿用同一精确时间窗口', async () => {
  const { group, session } = fixture();
  const range = { startTime: start, endTime: start };
  const report = await group.getGroupStatsReport(777n, range);
  expect(report.totals).toMatchObject({ totalMessages: rows, speakerCount: 2, activeDays: 1 });
  expect(report.daily).toEqual([{ date: '2026-10-18', count: rows }]);
  expect(report.timeline.daily.reduce((sum, day) => sum + day.count, 0)).toBe(rows + 2);
  expect(report.ranking[0]?.weekly.reduce((sum, count) => sum + count, 0)).toBe(rows / 2);
  expect(report.timeDistribution[0]).toBe(rows);
  expect(report.ranking.map((row) => row.messageCount)).toEqual([rows / 2, rows / 2]);
  // 消息行里的 senderUin 缺失时，名册（group_member3）的 QQ 号要补上 —— 排行卡靠它拼头像。
  expect(report.ranking.map((row) => row.uin).sort()).toEqual(['10001', '10002']);
  const member = await group.getGroupMemberAnalytics(777n, 'u_peer', start, start);
  expect(member.statistics.totalMessages).toBe(rows / 2);
  expect(member.timeDistribution[0]).toBe(rows / 2);
  const graph = await group.getGroupConversationGraph(777n, range);
  expect(graph.messageCount).toBe(rows);
  expect(graph.conversationCount).toBe(1);
  expect(graph.nodes).toHaveLength(2);
  const batches = await group.getGroupJoinBatches(777n, { startTime: start, endTime: start + 60 });
  expect(batches.memberTotal).toBe(6);
  expect(batches.batches).toHaveLength(1);
  expect(batches.batches[0]!.members.map((member) => member.uid)).toEqual([
    'u_self',
    'u_peer',
    'u_third',
  ]);
  expect(batches.groupMessageTotal).toBe(rows);
  expect((await group.getGroupStatsReport(777n)).totals.totalMessages).toBe(rows + 3);
  const members = await session.groupMembers.listMemberJoinBriefs(777n);
  vi.spyOn(session.groupMembers, 'listMemberJoinBriefs').mockResolvedValue([
    ...members,
    { ...members[0]!, uid: 'u_unknown', joinTime: 0 },
  ]);
  expect((await group.getGroupJoinBatches(777n, { endTime: start + 60 })).unknownJoinCount).toBe(0);
  expect((await group.getGroupJoinBatches(777n)).unknownJoinCount).toBe(1);
});

it('时间范围明确拒绝无效或反向边界，异常消息时间不伪造日期', async () => {
  expect(() => validateAnalyticsRange({ startTime: 2, endTime: 1 })).toThrow('不能晚于');
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => validateAnalyticsRange({ startTime: value })).toThrow('整数秒');
  expect(analyticsDayParts(start - 1)?.day).toBe('2026-10-17');
  expect(analyticsDayParts(start)?.day).toBe('2026-10-18');
  expect(analyticsDayParts(0)).toBeNull();
  expect(analyticsDayParts(Number.MAX_SAFE_INTEGER)).toBeNull();
  const { buddy, group } = fixture();
  await expect(buddy.getBuddyAnalytics('u_peer', { startTime: 2, endTime: 1 })).rejects.toThrow(
    '不能晚于',
  );
  await expect(group.getGroupStatsReport(777n, { startTime: 2, endTime: 1 })).rejects.toThrow(
    '不能晚于',
  );
});
