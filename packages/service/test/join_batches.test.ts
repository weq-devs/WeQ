/**
 * 入群批次（join_batches）的单测。
 *
 * 口径很简单，但有几条底线必须守住：
 *   - 三小时窗口内挤够人就成批，超出一分钟就要断开；
 *   - 门槛是 max(3, 群总人数 ÷ 20)，大群 1/20、小群保底 3 人；
 *   - 批次之间不重叠、按时间先后编号；
 *   - 入群时间缺失的人不进批次，也不影响别人。
 */

import { describe, expect, it } from 'vitest';
import {
  JOIN_BATCH_WINDOW_SECONDS,
  buildJoinBatchReport,
  joinBatchThreshold,
  type GroupJoinBatchMember,
} from '../src/account/join_batches';

/** 基准时刻（2024-01-01 UTC）。 */
const T0 = 1704067200;

function member(uid: string, atHours: number, messages = 10): GroupJoinBatchMember {
  return {
    uid,
    uin: uid,
    displayName: `用户${uid}`,
    joinTime: T0 + Math.round(atHours * 3600),
    lastSpeakTime: T0 + Math.round((atHours + 1) * 3600),
    memberLevel: 2,
    messageCount: messages,
  };
}

/** 入群时间未知（成员表里的 0）。 */
function undated(uid: string): GroupJoinBatchMember {
  return {
    uid,
    uin: uid,
    displayName: `用户${uid}`,
    joinTime: 0,
    lastSpeakTime: 0,
    memberLevel: 2,
    messageCount: 0,
  };
}

/** `n` 个人在 `startHours` 起的 `spreadHours` 内均匀挤进来（首位到末位正好铺满该跨度）。 */
function bunch(
  prefix: string,
  startHours: number,
  n: number,
  spreadHours = 2,
): GroupJoinBatchMember[] {
  const step = spreadHours / Math.max(n - 1, 1);
  return Array.from({ length: n }, (_, i) => member(`${prefix}${i}`, startHours + i * step));
}

describe('joinBatchThreshold', () => {
  it('大群取 1/20，小群保底 3 人', () => {
    expect(joinBatchThreshold(100)).toBe(5);
    expect(joinBatchThreshold(1000)).toBe(50);
    expect(joinBatchThreshold(2000)).toBe(100);
    expect(joinBatchThreshold(40)).toBe(3); // 1/20 = 2 → 抬到下限
    expect(joinBatchThreshold(20)).toBe(3);
    expect(joinBatchThreshold(0)).toBe(3);
  });
});

describe('buildJoinBatchReport', () => {
  it('三小时内挤够人 → 一个批次，跨度按秒保留', () => {
    // 100 人的群，门槛 5 人；5 个人在 2 小时内陆续进来。
    const group = bunch('a', 10, 5, 2);
    const report = buildJoinBatchReport(group, 500, 100);

    expect(report.threshold).toBe(5);
    expect(report.windowSeconds).toBe(JOIN_BATCH_WINDOW_SECONDS);
    expect(report.batches).toHaveLength(1);
    const batch = report.batches[0]!;
    expect(batch.index).toBe(1);
    expect(batch.members.map((m) => m.uid)).toEqual(group.map((m) => m.uid));
    expect(batch.spanSeconds).toBe(2 * 3600);
    expect(batch.messageCount).toBe(50);
    expect(batch.topSpeaker?.uid).toBe('a0');
  });

  it('恰好在 3 小时内算一批，超过 3 小时就断开', () => {
    const inside = [member('a0', 0), member('a1', 1), member('a2', 2), member('a3', 3)];
    const report = buildJoinBatchReport(inside, 100, 20); // 20 人群 → 门槛 3
    expect(report.batches).toHaveLength(1);
    expect(report.batches[0]!.members).toHaveLength(4);

    // 把最后一位挪到 3 小时零 1 分：前三个人成批，他掉队。
    const spill = [member('a0', 0), member('a1', 1), member('a2', 2), member('a3', 3 + 1 / 60)];
    const spilled = buildJoinBatchReport(spill, 100, 20);
    expect(spilled.batches).toHaveLength(1);
    expect(spilled.batches[0]!.members.map((m) => m.uid)).toEqual(['a0', 'a1', 'a2']);
    expect(spilled.batchMemberCount).toBe(3);
  });

  it('人数不到门槛就成不了批：大群里 4 个人不够 1/20', () => {
    const report = buildJoinBatchReport(bunch('a', 0, 4, 1), 100, 100); // 门槛 5
    expect(report.batches).toHaveLength(0);
    expect(report.batchMemberCount).toBe(0);
  });

  it('小群也有 3 人的底：20 人的群里三个人一起进来', () => {
    const report = buildJoinBatchReport(bunch('a', 0, 3, 1), 30, 20);
    expect(report.threshold).toBe(3);
    expect(report.batches).toHaveLength(1);
    expect(report.batches[0]!.members).toHaveLength(3);
  });

  it('两波人 → 两个批次，按时间先后编号且不重叠', () => {
    const members = [...bunch('a', 0, 4, 1), ...bunch('b', 100, 5, 1), ...bunch('c', 500, 6, 1)];
    const report = buildJoinBatchReport(members, 1000, 60); // 门槛 3
    expect(report.batches.map((b) => b.index)).toEqual([1, 2, 3]);
    expect(report.batches.map((b) => b.members.length)).toEqual([4, 5, 6]);
    expect(report.batches[0]!.startTime).toBe(T0);
    expect(report.batches[1]!.startTime).toBe(T0 + 100 * 3600);

    // 同一个人不会出现在两个批次里。
    const seen = new Set<string>();
    for (const batch of report.batches) {
      for (const m of batch.members) {
        expect(seen.has(m.uid)).toBe(false);
        seen.add(m.uid);
      }
    }
  });

  it('入群时间缺失的人只计进 unknownJoinCount，不参与成批', () => {
    const members = [...bunch('a', 0, 3, 1), undated('x'), undated('y')];
    const report = buildJoinBatchReport(members, 50, 20);
    expect(report.unknownJoinCount).toBe(2);
    expect(report.datedMemberCount).toBe(3);
    expect(report.memberTotal).toBe(20);
    expect(report.batches[0]!.members).toHaveLength(3);
  });

  it('没传群总人数时用成员数兜底（小群门槛仍是 3）', () => {
    const report = buildJoinBatchReport(bunch('a', 0, 3, 1), 30);
    expect(report.threshold).toBe(3);
    expect(report.batches).toHaveLength(1);
  });

  it('全员都没有入群时间 → 空报告，不炸', () => {
    const report = buildJoinBatchReport([undated('x'), undated('y')], 10, 2);
    expect(report.datedMemberCount).toBe(0);
    expect(report.batches).toEqual([]);
    expect(report.firstJoinTime).toBe(0);
    expect(report.lastJoinTime).toBe(0);
    expect(report.threshold).toBe(3);
  });

  it('全团潜水 → 没有话痨，消息占比为 0', () => {
    const report = buildJoinBatchReport(
      bunch('a', 0, 3, 1).map((m) => ({ ...m, messageCount: 0 })),
      0,
      20,
    );
    expect(report.batches[0]!.topSpeaker).toBeNull();
    expect(report.batches[0]!.messageCount).toBe(0);
    expect(report.groupMessageTotal).toBe(0);
  });
});
