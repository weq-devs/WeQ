import { describe, expect, it } from 'vitest';
import type { MonitorPrunePreview } from '@weq/service/performance';
import { preciseTimeFormatter } from '@weq/time';
import { performancePruneMessage } from '../src/renderer/src/lib/performanceRetention';

const cutoff = Date.UTC(2026, 10, 10, 3, 0, 0);
const preview: MonitorPrunePreview = {
  bytes: 70 * 1048576,
  records: 100,
  oldest: cutoff - 86400_000,
  newest: cutoff + 86400_000,
  cutoff,
  retentionDays: 3,
  capacityMiB: 64,
  capacityBudgetBytes: 64 * 1048576 * 0.9,
  expiredRecords: 12,
  capacityExceeded: false,
  needsPrune: true,
};
describe('性能历史删除确认文案', () => {
  it('时长删除显示当前占用、新天数、真实截止时间和过期条数', () => {
    const text = performancePruneMessage(preview);
    expect(text).toContain('当前性能历史占用 70 MiB');
    expect(text).toContain('保存时长改为 3 天');
    expect(text).toContain(
      `北京时间 ${preciseTimeFormatter.format(new Date(cutoff))} 之前的 12 条记录`,
    );
    expect(text).not.toContain('容量上限设为');
  });
  it('容量删除显示当前与新容量、实际回收目标，不编造删除截止日期', () => {
    const text = performancePruneMessage({ ...preview, expiredRecords: 0, capacityExceeded: true });
    expect(text).toContain('当前性能历史占用 70 MiB');
    expect(text).toContain('容量上限设为 64 MiB');
    expect(text).toContain('实际回收目标为 57.6 MiB');
    expect(text).toContain('从最旧记录开始删除');
    expect(text).not.toContain('之前的');
  });
  it('同时受时间和容量影响时明确先按时间清理，再按剩余占用处理', () => {
    expect(performancePruneMessage({ ...preview, capacityExceeded: true })).toContain(
      '按时间清理后如仍超出目标',
    );
  });
});
