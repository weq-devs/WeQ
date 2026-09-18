/**
 * 小团体聚类（join_clusters）的单测。
 *
 * 这套判定是「猜人际关系」，没有绝对正确答案，但有几条底线必须守住：
 *   - **短时间**里一起进来的人要成伙（同一天 / 连续两三天），人少也算；
 *   - 长时间里匀速来一大堆人（例如 20 天进 300 人）**不能**被切成「小团体」；
 *   - 老群长期缓慢拉人时，中间那一波集中的要认出来；
 *   - 门槛要跟**本群自己**比：同样的「一天 5 人」，安静群里算一伙，天天成批进人的群里不算；
 *   - 人太多的波次算拉新潮（waves），不能混进「小」团体；
 *   - 新群 / 小群（平均密度就等于这一波）不能被密度公式判死；
 *   - 入群时间缺失的人不能凭空造出团体，也不能把别人挤散。
 *
 * 数据全部按固定步长生成，避免「背景里恰好有人落在同一窗口」导致的偶然。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JOIN_CLUSTER_CRITERIA,
  buildJoinClusterReport,
  type GroupJoinClusterMember,
  type JoinClusterCriteria,
} from '../src/account/join_clusters';

const DAY = 86400;
/** 基准时刻（2024-01-01 UTC），让时间断言可读。 */
const T0 = 1704067200;

/** `joinDay = null` 表示入群时间未知（成员表里的 0）；支持小数天（同一天的不同时刻）。 */
function member(uid: string, joinDay: number | null, messages = 10): GroupJoinClusterMember {
  return {
    uid,
    uin: uid,
    displayName: `用户${uid}`,
    joinTime: joinDay === null ? 0 : T0 + Math.round(joinDay * DAY),
    lastSpeakTime: joinDay === null ? 0 : T0 + Math.round((joinDay + 1) * DAY),
    memberLevel: 2,
    messageCount: messages,
  };
}

/** 一波人：`withinDays` 天内均匀铺开（默认挤在同一天里）。 */
function wave(
  prefix: string,
  startDay: number,
  n: number,
  withinDays = 0.9,
  messages = 20,
): GroupJoinClusterMember[] {
  return Array.from({ length: n }, (_, i) =>
    member(`${prefix}${i}`, startDay + (n === 1 ? 0 : (i / n) * withinDays), messages),
  );
}

/** 一小时内接连进来的 n 个人（每人相隔 1 分钟）—— 最短档的典型形态。 */
function burst(
  prefix: string,
  startDay: number,
  n: number,
  minutesApart = 1,
  messages = 20,
): GroupJoinClusterMember[] {
  return Array.from({ length: n }, (_, i) =>
    member(`${prefix}${i}`, startDay + (i * minutesApart) / (24 * 60), messages),
  );
}

/** 背景人群：从 `from` 起每隔 `stepDays` 天来一个 —— 确定、彼此离得远。 */
function scattered(
  prefix: string,
  from: number,
  count: number,
  stepDays: number,
  messages = 10,
): GroupJoinClusterMember[] {
  return Array.from({ length: count }, (_, i) =>
    member(`${prefix}${i}`, from + i * stepDays, messages),
  );
}

/** 匀速涌进来的一大批人（`total` 人铺满 `spanDays` 天）—— 用来当「匀速拉人」的反例。 */
function flood(prefix: string, total: number, spanDays: number): GroupJoinClusterMember[] {
  return Array.from({ length: total }, (_, i) =>
    member(`${prefix}${i}`, (i * spanDays) / total, 10),
  );
}

/** 两年历史、每隔 40 天来一个人的老群背景（最近的一个离第 1000 天还有 5 天）。 */
const OLD_GROUP = scattered('u', 205, 40, 40);

/** 改动窗口天数时的口径：其余字段跟着默认走，免得以后加字段测试全挂。 */
function withWindow(windowDays: number): JoinClusterCriteria {
  return { ...DEFAULT_JOIN_CLUSTER_CRITERIA, windowDays };
}

describe('buildJoinClusterReport', () => {
  it('同一天涌进来的一波 + 两年里零散的人 → 1 伙 + 游离', () => {
    const group = wave('a', 10, 6);
    const rest = scattered('s', 200, 12, 40);
    const report = buildJoinClusterReport([...group, ...rest], 6 * 20 + 12 * 10);

    expect(report.clusters).toHaveLength(1);
    const cluster = report.clusters[0]!;
    expect(cluster.members).toHaveLength(6);
    expect(cluster.spanDays).toBeLessThan(1);
    expect(cluster.members.map((m) => m.uid)).toEqual(group.map((m) => m.uid));
    expect(cluster.messageCount).toBe(120);
    expect(cluster.topSpeaker?.uid).toBe('a0');
    expect(report.drifters).toHaveLength(12);
    expect(report.allInOneWave).toBe(false);
    expect(report.waves).toHaveLength(0);
  });

  it('老群里一天来了三个人也算一伙（人少不是问题，时间短才是信号）', () => {
    const group = wave('a', 1000, 3);
    const report = buildJoinClusterReport([...OLD_GROUP, ...group], 2000);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]!.members.map((m) => m.uid)).toEqual(group.map((m) => m.uid));
  });

  it('1 小时内挤进来的人命中最短档，跨度保留秒级分辨率', () => {
    // 同一个小时里的 4 个人（每人相隔 12 分钟）+ 两年零散背景。
    const group = burst('a', 1000, 4, 12);
    const report = buildJoinClusterReport([...OLD_GROUP, ...group], 1000);
    const cluster = report.clusters[0]!;
    expect(cluster.windowSeconds).toBe(3600);
    expect(cluster.members).toHaveLength(4);
    // 36 分钟就是 0.025 天 —— 以前四舍五入到 0.1 天会把这条信息抹掉。
    expect(cluster.spanDays).toBeGreaterThan(0);
    expect(cluster.spanDays).toBeLessThan(1 / 24);
  });

  it('某天只来两个人 → 不成伙（两个人不叫团体）', () => {
    const report = buildJoinClusterReport([...OLD_GROUP, ...wave('a', 1000, 2)], 2000);
    expect(report.clusters).toHaveLength(0);
    expect(report.drifters).toHaveLength(42);
  });

  it('20 天里匀速涌进 300 人 → 不是小团体，也不是潮汐（就是这个群的常态速度）', () => {
    const report = buildJoinClusterReport(flood('u', 300, 20), 3000);
    expect(report.clusters).toHaveLength(0);
    // 每 96 分钟来一个、连来 20 天：局部速度 = 全群平均速度，两倍门槛过不了。
    expect(report.waves).toHaveLength(0);
    expect(report.waveMemberCount).toBe(0);
    expect(report.drifters).toHaveLength(300);
  });

  it('潮汐也要比平均速度快：慢慢涨上来的大群不产生拉新潮', () => {
    // 每 3 小时来一个、连来 60 天（共 480 人）—— 人多，但速度就是全群平均速度。
    const stream = Array.from({ length: 480 }, (_, i) => member(`t${i}`, 500 + i * 0.125, 5));
    const report = buildJoinClusterReport(stream, 5000);
    expect(report.clusters).toHaveLength(0);
    expect(report.waves).toHaveLength(0);
    expect(report.drifters).toHaveLength(480);

    // 同样 480 人，但挤在两天里 → 潮汐。
    const bursty = Array.from({ length: 480 }, (_, i) => member(`b${i}`, 500 + i * 0.004, 5));
    const fast = buildJoinClusterReport([...bursty, ...scattered('u', 800, 40, 30)], 5000);
    expect(fast.clusters).toHaveLength(0);
    expect(fast.waves).toHaveLength(1);
    expect(fast.waves[0]!.memberCount).toBe(480);
  });

  it('慢群里的「每 12 小时来一个」只算小簇，不会被串成一整大波', () => {
    // 45 天里每 12 小时来一个（比全群平均快得多），跨年后还有零星的几个人。
    const stream = Array.from({ length: 90 }, (_, i) => member(`t${i}`, 200 + i * 0.5, 5));
    const report = buildJoinClusterReport([...stream, ...scattered('u', 600, 6, 40)], 1000);
    expect(report.clusters.length).toBeGreaterThan(0);
    // 跨度上限生效：不会有任何一伙跨过最长窗口，更不会把 90 人的流水线串成一波。
    expect(report.clusters.every((c) => c.spanDays <= 3)).toBe(true);
    expect(Math.max(...report.clusters.map((c) => c.members.length))).toBeLessThan(10);
    expect(report.waves).toHaveLength(0);
  });

  it('一小时涌进 50 人 → 拉新潮，不算小团体也不算游离', () => {
    const group = burst('f', 1000, 50);
    const report = buildJoinClusterReport([...OLD_GROUP, ...group], 1000);
    expect(report.clusters).toHaveLength(0);
    expect(report.waves).toHaveLength(1);
    expect(report.waves[0]!.memberCount).toBe(50);
    expect(report.waves[0]!.spanDays).toBeLessThan(1 / 24);
    expect(report.waveMemberCount).toBe(50);
    expect(report.drifters).toHaveLength(40);
  });

  it('门槛跟本群自己比：同样的「一小时 5 人」在安静群成伙、在成批进人的群排不上号', () => {
    const quiet = buildJoinClusterReport([...OLD_GROUP, ...burst('q', 1000, 5)], 1000);
    expect(quiet.clusters).toHaveLength(1);
    expect(quiet.clusters[0]!.members).toHaveLength(5);

    // 同一个群，但历史上常常成批进人（每 30 天一波 12 人，另有每 3 天一个的散人）。
    const batches = Array.from({ length: 20 }, (_, k) => burst(`b${k}`, 100.5 + k * 30, 12, 5));
    const filler = scattered('s', 10, 220, 3, 5);
    const busy = buildJoinClusterReport(
      [...batches.flat(), ...filler, ...burst('q', 1000, 5)],
      1000,
    );
    expect(busy.clusters.length).toBeGreaterThan(5);
    expect(busy.clusters.some((c) => c.members.some((m) => m.uid.startsWith('q')))).toBe(false);
    expect(busy.drifters.some((m) => m.uid.startsWith('q'))).toBe(true);
  });

  it('全员在几天内陆续进来的新群 → 整体算一伙，没有游离', () => {
    const members = wave('a', 0, 6, 2.5, 5);
    const report = buildJoinClusterReport(members, 30);
    expect(report.allInOneWave).toBe(true);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]!.members).toHaveLength(6);
    expect(report.drifters).toHaveLength(0);
    expect(report.driftMessageShare).toBe(0);
  });

  it('窗口天数决定「多短算一波」：2.5 天的 4 个人在 1 天口径下不算', () => {
    const members = [...scattered('u', 0, 30, 6.7), ...wave('a', 300, 4, 2.5)];
    const three = buildJoinClusterReport(members, 1000, withWindow(3));
    const one = buildJoinClusterReport(members, 1000, withWindow(1));
    expect(three.clusters).toHaveLength(1);
    expect(three.clusters[0]!.members).toHaveLength(4);
    expect(one.clusters).toHaveLength(0);
  });

  it('两波紧邻的集中入群 → 两个团体，按时间先后编号', () => {
    const members = [...wave('a', 0, 5), ...wave('b', 300, 6), ...scattered('s', 50, 20, 20)];
    const report = buildJoinClusterReport(members, 1000);
    expect(report.clusters.map((c) => c.index)).toEqual([1, 2]);
    expect(report.clusters.map((c) => c.members.length)).toEqual([5, 6]);
    expect(report.clusters[0]!.startTime).toBe(T0);
    expect(report.clusters[1]!.startTime).toBe(T0 + 300 * DAY);
  });

  it('各档门槛由短到长都报出来，且不低于人数下限', () => {
    const report = buildJoinClusterReport([...OLD_GROUP, ...wave('a', 1000, 5)], 1000);
    expect(report.tierNeeds.map((t) => t.windowSeconds)).toEqual([3600, 6 * 3600, DAY, 3 * DAY]);
    expect(report.tierNeeds.every((t) => t.minCount >= DEFAULT_JOIN_CLUSTER_CRITERIA.minSize)).toBe(
      true,
    );
    expect(report.minClusterSize).toBe(report.tierNeeds[0]!.minCount);
    expect(report.meanGapSeconds).toBeGreaterThan(0);
  });

  it('入群时间缺失的人进 unknownJoinCount，不参与成团', () => {
    const members = [...wave('a', 0, 5, 0.5, 4), member('x', null), member('y', null)];
    const report = buildJoinClusterReport(members, 100);
    expect(report.unknownJoinCount).toBe(2);
    expect(report.totalMembers).toBe(5);
    expect(report.clusters[0]!.members).toHaveLength(5);
    expect(report.drifters).toHaveLength(0);
  });

  it('全员都没有入群时间 → 空报告，不炸', () => {
    const report = buildJoinClusterReport([member('x', null), member('y', null)], 10);
    expect(report.totalMembers).toBe(0);
    expect(report.clusters).toEqual([]);
    expect(report.drifters).toEqual([]);
    expect(report.minClusterSize).toBe(DEFAULT_JOIN_CLUSTER_CRITERIA.minSize);
    expect(report.tierNeeds).toEqual([]);
    expect(report.firstJoinTime).toBe(0);
  });

  it('全员潜水 → 团体没有话痨，占比为 0', () => {
    const members = wave('a', 0, 5, 0.5, 0);
    const report = buildJoinClusterReport(members, 0);
    expect(report.clusters[0]!.topSpeaker).toBeNull();
    expect(report.clusters[0]!.messageShare).toBe(0);
    expect(report.groupMessageTotal).toBe(0);
    expect(report.driftMessageShare).toBe(0);
  });

  it('大群里的「常态速度」会抬高门槛，小群则按人数兜底', () => {
    // 同是「一天 4 人」：20 人的小组里成立……
    const small = buildJoinClusterReport([...wave('a', 0, 4), ...scattered('s', 20, 16, 25)], 100);
    expect(small.clusters).toHaveLength(1);

    // ……而每 12 小时就来一个、连来 300 天的大群里连一伙都算不上。
    const busy = buildJoinClusterReport(flood('u', 600, 300), 6000);
    expect(busy.clusters).toHaveLength(0);
    expect(Math.max(...busy.tierNeeds.map((t) => t.minCount))).toBeGreaterThan(6);
  });

  it('人数上限之外的波次归潮汐，不占卡片', () => {
    // 上限压到 4 人：同一天来的 6 个人只能算潮汐。
    const report = buildJoinClusterReport([...OLD_GROUP, ...wave('a', 1000, 6)], 1000, {
      ...withWindow(3),
      maxSize: 4,
    });
    expect(report.clusters).toHaveLength(0);
    expect(report.waves).toHaveLength(1);
    expect(report.waves[0]!.memberCount).toBe(6);
  });

  it('拉新潮里的人不会出现在游离分子里（两边不重复计数）', () => {
    const report = buildJoinClusterReport([...OLD_GROUP, ...burst('f', 1000, 50)], 1000);
    expect(report.drifters.length + report.waveMemberCount).toBe(report.totalMembers);
    expect(report.drifters.some((m) => m.uid.startsWith('f'))).toBe(false);
  });
});
