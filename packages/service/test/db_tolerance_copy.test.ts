/**
 * 宽容级别文案的守卫测试。
 *
 * 这些断言存在的唯一目的：**防止文案比实际能力更宽**。
 *
 * 背景（2026-09-20，真实损坏库实测）：
 *  - 聚合查询（年度报告）在级别 0/1/2/3 下表现完全一致，都直接报
 *    `database disk image malformed`；
 *  - 级别 2 的跳过只存在于导出这类"按会话键轴分块"的链路；
 *  - 级别 3 的隔离粒度是整张表。
 *
 * 一旦有人把这些边界写宽（例如把"只有导出"写成"所有查询"、把"大概率无效"写成
 * "有助于恢复"、或者把键跨度说成行数），这里就会红 —— 文案错比功能错更难被发现。
 */

import { describe, expect, it } from 'vitest';
import { clampSalvageLevel } from '@weq/db';
import {
  SALVAGE_AGGREGATE_CAVEAT,
  SALVAGE_EXPERIMENTAL_NOTE,
  SALVAGE_EXPERIMENTAL_TAG,
  SALVAGE_LEVEL_COPY,
  SALVAGE_SKIPPED_SPAN_CAVEAT,
  clampSalvageLevelCopy,
  salvageLevelCopy,
  salvageLevelToast,
  salvageLevelsAscending,
} from '../src/account/db_tolerance_copy';

describe('宽容级别文案', () => {
  it('覆盖 0..3 四级且顺序稳定（严格也要占一行）', () => {
    expect(SALVAGE_LEVEL_COPY.map((copy) => copy.level)).toEqual([0, 1, 2, 3]);
    expect(salvageLevelsAscending()).toBe(SALVAGE_LEVEL_COPY);
    expect(SALVAGE_LEVEL_COPY[0]?.title).toContain('严格');
  });

  it('本地的级别归一与 @weq/db 的 clampSalvageLevel 逐项对拍（零依赖不能变成第二套语义）', () => {
    const cases = [0, 1, 2, 3, -1, 4, 99, 2.7, -0.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of cases) {
      expect(clampSalvageLevelCopy(value)).toBe(clampSalvageLevel(value));
    }
    expect(clampSalvageLevelCopy('2')).toBe(clampSalvageLevel('2'));
    expect(clampSalvageLevelCopy(null)).toBe(clampSalvageLevel(null));
  });

  it('越界级别回到严格（与 clampSalvageLevel 同一套口径），不返回 undefined', () => {
    // 平台语义是"非法值一律回到严格"（不是夹到 3）—— 文案跟着走，宁可少说多。
    expect(salvageLevelCopy(-5).level).toBe(0);
    expect(salvageLevelCopy(99).level).toBe(0);
    expect(salvageLevelCopy(4).level).toBe(0);
    expect(salvageLevelCopy(2.7).level).toBe(2);
    expect(salvageLevelCopy(Number.NaN).level).toBe(0);
  });

  it('只有会丢数据的级别（2 / 3）要求二次确认，且级别 1 明确"不丢数据"', () => {
    const byLevel = new Map(SALVAGE_LEVEL_COPY.map((copy) => [copy.level, copy]));
    expect(byLevel.get(0)?.losesData).toBe(false);
    expect(byLevel.get(1)?.losesData).toBe(false);
    expect(byLevel.get(2)?.losesData).toBe(true);
    expect(byLevel.get(3)?.losesData).toBe(true);
    expect(byLevel.get(1)?.summary).toContain('不丢数据');
    for (const level of [2, 3])
      expect(byLevel.get(level)?.confirm?.length ?? 0).toBeGreaterThan(20);
  });

  it('级别 2 的生效范围只说导出，不冒领聊天页 / 搜索 / 聚合', () => {
    const scope = salvageLevelCopy(2).scope;
    expect(scope).toContain('导出');
    expect(scope).toContain('聊天页');
    expect(scope).toContain('年度报告');
    expect(scope).not.toContain('所有读查询');
    expect(scope).not.toContain('全部查询');
  });

  it('级别 3 说明隔离粒度是整表（会波及健康数据）', () => {
    const copy = salvageLevelCopy(3);
    expect(copy.scope).toContain('表名');
    expect(copy.scope).toContain('所有');
    expect(copy.confirm).toContain('完好');
  });

  it('实验性标签与说明都在，且说明解释了"为什么只覆盖一部分"', () => {
    expect(SALVAGE_EXPERIMENTAL_TAG).toBe('实验性');
    expect(SALVAGE_EXPERIMENTAL_NOTE).toContain('聚合');
    expect(SALVAGE_EXPERIMENTAL_NOTE).toContain('导出');
  });

  it('聚合查询警告点名年度报告，并给出"只有修复才能恢复"的结论', () => {
    expect(SALVAGE_AGGREGATE_CAVEAT).toContain('年度报告');
    expect(SALVAGE_AGGREGATE_CAVEAT).toContain('没有效果');
    expect(SALVAGE_AGGREGATE_CAVEAT).toContain('修复');
  });

  it('跳过区间一律按"键区间"表述，不许出现"最多丢 N 行 / N 条"的口径', () => {
    expect(SALVAGE_SKIPPED_SPAN_CAVEAT).toContain('不是条数');
    const everything = [
      SALVAGE_SKIPPED_SPAN_CAVEAT,
      SALVAGE_AGGREGATE_CAVEAT,
      ...SALVAGE_LEVEL_COPY.map((copy) => `${copy.summary}${copy.scope}${copy.confirm ?? ''}`),
    ].join('\n');
    expect(everything).not.toMatch(/最多.{0,4}(丢|少).{0,4}\d*\s*(行|条|条消息)/);
    expect(everything).not.toContain('行数上界');
  });

  it('切换级别的 toast 都带上覆盖范围与聚合警告，不会只说"已开启"', () => {
    for (const level of [0, 1, 2, 3]) {
      const toast = salvageLevelToast(level);
      expect(toast.title.length).toBeGreaterThan(0);
      expect(toast.detail.length).toBeGreaterThan(20);
      if (level >= 1) expect(toast.detail).toContain('年度报告');
    }
    expect(salvageLevelToast(2).detail).toContain('缺失');
    expect(salvageLevelToast(0).title).toContain('严格');
  });
});
