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
import { GapHistoryService, type GapFetchedMessage } from '../src/account/gap_history';
import type { AnalyticsCacheSource } from '../src/account/analytics_source';
import * as textSegment from '../src/account/text_segment';

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
    sql.exec(`ALTER TABLE ${table} ADD COLUMN "40013" INTEGER DEFAULT 0`);
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

function roamingFixture() {
  const { session } = fixture();
  const cached: GapFetchedMessage[] = [];
  const add = (kind: 'group' | 'c2c', conv: string, values: Partial<GapFetchedMessage> = {}) => {
    const row: GapFetchedMessage = {
      kind,
      conv,
      msgId: '100000',
      msgSeq: '4',
      sendTime: String(start + 10),
      senderUid: 'u_peer',
      senderUin: '10002',
      ntSeqVerified: true,
      sourceFormat: 'protocol',
      elements: [{ type: 'text', data: { textContent: '漫游分析' } }],
      ...values,
    };
    cached.push(row);
    return row;
  };
  const cache: AnalyticsCacheSource = {
    cachedForExport: async () => cached,
    cachedConversations: async () => [
      { kind: 'c2c', conv: 'u_cached', lastMessageTime: start + 10 },
      { kind: 'group', conv: '888', lastMessageTime: start + 10 },
    ],
  };
  const group = new GroupInfoService(session);
  group.setAnalysisCache(cache);
  return { session, cached, add, cache, group, buddy: new BuddyAnalyticsService(session, cache) };
}

it('漫游缓存补入私聊和群画像，时间线、词云、成员、入群批次和小团体统计保持一致', async () => {
  vi.spyOn(textSegment, 'segmentWords').mockImplementation((text) => [text]);
  const { buddy, group, add } = roamingFixture();
  add('c2c', 'u_peer');
  add('group', '777');
  add('group', '777', {
    msgId: '100001',
    senderUid: 'u_self',
    senderUin: '10001',
    sendTime: String(start + 20),
    elements: [{ type: 'face', data: { faceId: 14, faceText: '微笑' } }],
  });
  const privateReport = await buddy.getBuddyAnalytics('u_peer', {
    startTime: start,
    endTime: start + 20,
  });
  expect(privateReport.statistics.totalMessages).toBe(rows + 1);
  expect(privateReport.statistics.peerMessages).toBe(rows / 2 + 1);
  expect(privateReport.wordCloud.length).toBeGreaterThan(0);
  const range = { startTime: start + 1, endTime: start + 20 };
  const report = await group.getGroupStatsReport(777n, range);
  expect(report.totals).toMatchObject({
    totalMessages: 2,
    textMessages: 1,
    emojiMessages: 1,
    speakerCount: 2,
  });
  expect(report.timeline.daily.reduce((sum, day) => sum + day.count, 0)).toBe(rows + 4);
  expect(
    (await group.getGroupMemberAnalytics(777n, 'u_peer', range.startTime, range.endTime)).statistics
      .totalMessages,
  ).toBe(1);
  expect((await group.getGroupConversationGraph(777n, range)).messageCount).toBe(2);
  expect((await group.getGroupJoinBatches(777n, range)).groupMessageTotal).toBe(2);
  expect(
    (await group.getGroupMessageRanking(777n, 10, range.startTime, range.endTime)).map(
      (row) => row.messageCount,
    ),
  ).toEqual([1, 1]);
  expect(
    (await group.getGroupWordCloud(777n, 10, range.startTime, range.endTime)).length,
  ).toBeGreaterThan(0);
  expect(await group.getGroupDailyActivity(777n, range.startTime, range.endTime)).toEqual([
    { date: '2026-10-18', count: 2 },
  ]);
});

it('缓存按时间混排计算回复，缓存独有会话支持默认最近一年且不接受未确认私聊或其他会话', async () => {
  const { buddy, group, add } = roamingFixture();
  add('c2c', 'u_ordered', { senderUid: 'u_ordered', sendTime: String(start + 4) });
  const ordered = await buddy.getBuddyAnalytics('u_ordered');
  expect(ordered.statistics.totalMessages).toBe(3);
  expect(ordered.reply.self).toMatchObject({ fastestSec: 1, count: 1 });
  add('c2c', 'u_cached', { senderUid: 'u_cached' });
  add('c2c', 'u_cached', { msgId: '100002', msgSeq: '5', ntSeqVerified: false });
  add('group', '888');
  const privateReport = await buddy.getBuddyAnalytics('u_cached', { recentYear: true });
  expect(privateReport.statistics.totalMessages).toBe(1);
  expect(privateReport.range).toMatchObject({ defaulted: true, endTime: start + 10 });
  expect((await group.getGroupStatsReport(888n, { recentYear: true })).totals.totalMessages).toBe(
    1,
  );
});

it('漫游选区精确识别来源，不把同秒或同序号未选消息和空选区并入统计', async () => {
  const { buddy, group, add } = roamingFixture();
  for (const kind of ['group', 'c2c'] as const) {
    const conv = kind === 'group' ? '777' : 'u_peer';
    add(kind, conv);
    add(kind, conv, { msgId: '100001' });
  }
  const scope = { messageIds: ['1', 'roaming:protocol:4:100000'] };
  expect((await buddy.getBuddyAnalytics('u_peer', scope)).statistics.totalMessages).toBe(2);
  expect((await group.getGroupStatsReport(777n, scope)).totals.totalMessages).toBe(2);
  expect((await group.getGroupConversationGraph(777n, scope)).messageCount).toBe(2);
  expect((await group.getGroupJoinBatches(777n, scope)).groupMessageTotal).toBe(2);
  expect(
    (await buddy.getBuddyAnalytics('u_peer', { messageIds: [] })).statistics.totalMessages,
  ).toBe(0);
  expect((await group.getGroupStatsReport(777n, { messageIds: [] })).totals.totalMessages).toBe(0);
});

it('缓存与本地副本按身份去重，缓存选中后同步入本地也只计一次，时间差不破坏去重', async () => {
  const { buddy, group, add } = roamingFixture();
  const sql = fixtureDb(join(root, 'msg.db'));
  for (const table of ['c2c_msg_table', 'group_msg_table'])
    sql.exec(`UPDATE ${table} SET "40002"=123 WHERE "40001"=4`);
  for (const kind of ['group', 'c2c'] as const) {
    const conv = kind === 'group' ? '777' : 'u_peer';
    add(kind, conv, { msgId: '4', msgSeq: '1' });
    add(kind, conv, { msgId: '123', msgSeq: '1', msgRandom: '123' });
    add(kind, conv, { msgId: '555', msgSeq: '1', sourceFormat: undefined });
  }
  expect((await buddy.getBuddyAnalytics('u_peer')).statistics.totalMessages).toBe(rows + 3);
  expect((await group.getGroupStatsReport(777n)).totals.totalMessages).toBe(rows + 3);
  const scope = { messageIds: ['4', 'roaming:protocol:1:123'] };
  expect((await buddy.getBuddyAnalytics('u_peer', scope)).statistics.totalMessages).toBe(1);
  expect((await group.getGroupStatsReport(777n, scope)).totals.totalMessages).toBe(1);
  // 不同身份的新原生消息即使同序号也不能丢弃。
  add('group', '777', { msgId: '999999', msgSeq: '1', sourceFormat: 'native' });
  expect((await group.getGroupStatsReport(777n)).totals.totalMessages).toBe(rows + 4);
});

it('真实缓存读取经过隐藏过滤，离线分析不调用漫游网络能力', async () => {
  const { session } = fixture();
  const nt = createSqliteStub();
  const history = new GapHistoryService(
    nt,
    session,
    () => {
      throw new Error('不应请求网络');
    },
    join(root, 'roam.db'),
    {
      isHiddenCached: (row: GapFetchedMessage) => row.msgId === '42',
      listHiddenIds: () => ['roaming:2:42'],
    } as never,
  );
  await history.retainForBatch([
    {
      kind: 'group',
      conv: '888',
      msgId: '41',
      msgSeq: '1',
      senderUid: 'u_peer',
      senderUin: '10002',
      sendTime: String(start),
      elements: [],
    },
    {
      kind: 'group',
      conv: '888',
      msgId: '42',
      msgSeq: '2',
      senderUid: 'u_peer',
      senderUin: '10002',
      sendTime: String(start + 1),
      elements: [],
    },
  ]);
  const group = new GroupInfoService(session);
  group.setAnalysisCache(history);
  expect((await group.getGroupStatsReport(888n)).totals.totalMessages).toBe(1);
  expect(await history.cachedConversations()).toEqual([
    { kind: 'group', conv: '888', lastMessageTime: start },
  ]);
});

it('超过两千条的缓存独有历史不截断，群关系统计仍走轻量身份分页', async () => {
  const { buddy, group, session, add } = roamingFixture();
  for (let i = 0; i < 2103; i++) {
    const values = {
      msgId: String(10000000 + i),
      msgSeq: String(i + 1),
      sendTime: String(start + i),
    };
    add('c2c', 'u_cached', { ...values, senderUid: 'u_cached' });
    add('group', '888', values);
  }
  expect((await buddy.getBuddyAnalytics('u_cached')).statistics.totalMessages).toBe(2103);
  // 关系和批次统计不应为了缓存补全改成扫描全部正文。
  vi.spyOn(session.groupMsgs, 'browse').mockRejectedValue(new Error('不应读取正文页'));
  expect((await group.getGroupConversationGraph(888n)).messageCount).toBe(2103);
  expect((await group.getGroupJoinBatches(888n)).groupMessageTotal).toBe(2103);
});

it('按 QQ 号分析缓存中缺 UID 的旧成员，不混入其他成员，表情字段沿用渲染值', async () => {
  const { group, add } = roamingFixture();
  add('group', '888', {
    senderUid: '',
    senderUin: '10003',
    elements: [{ type: 'face', data: { faceId: 14, faceText: '微笑' } }],
  });
  add('group', '888', { msgId: '100001', senderUin: '10004' });
  const report = await group.getGroupMemberAnalytics(888n, '', undefined, undefined, '10003');
  expect(report.statistics).toMatchObject({ totalMessages: 1, emojiMessages: 1 });
  expect(report.commonEmojis).toEqual([{ faceId: 14, faceText: '微笑', count: 1 }]);
});
