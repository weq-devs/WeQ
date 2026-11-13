import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNextRun, resolveRange, ExportScheduler } from '../src/account/export/scheduler';
import type { ExportTaskManager } from '../src/account/export/task_manager';

describe('定时导出采用北京时间', () => {
  it('每日触发以北京墙钟为准，恰好到点安排次日', () => {
    const config = { mode: 'daily' as const, time: '03:00', intervalHours: 6 };
    const at = Date.parse('2026-03-08T02:59:59+08:00') / 1000;
    expect(computeNextRun(config, at)).toBe(at + 1);
    expect(computeNextRun(config, at + 1)).toBe(at + 1 + 86400);
  });
  it('北京跨年自然日与最近七天保留包含端点语义', () => {
    const at = Date.parse('2026-01-01T00:01:00+08:00') / 1000;
    expect(resolveRange({ preset: 'today', start: null, end: null }, at)).toEqual({
      start: Date.parse('2026-01-01T00:00:00+08:00') / 1000,
      end: Date.parse('2026-01-01T23:59:59+08:00') / 1000,
    });
    expect(resolveRange({ preset: '7d', start: null, end: null }, at)).toEqual({
      start: Date.parse('2025-12-26T00:00:00+08:00') / 1000,
      end: Date.parse('2026-01-01T23:59:59+08:00') / 1000,
    });
    expect(resolveRange({ preset: 'custom', start: 123, end: 456 }, at)).toEqual({
      start: 123,
      end: 456,
    });
    expect(computeNextRun({ mode: 'interval', time: '03:00', intervalHours: 6 }, at)).toBe(
      at + 21600,
    );
  });
  it('载入时只重算未来每日计划，不改逾期记录和历史', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-03-08T02:59:59+08:00') / 1000;
    vi.setSystemTime(now * 1000);
    const root = mkdtempSync(join(tmpdir(), 'weq-scheduler-zone-'));
    const history = [{ at: now - 86400, outcome: 'completed', taskIds: ['old'] }];
    const schedule = { mode: 'daily', time: '03:00', intervalHours: 6 };
    writeFileSync(
      join(root, 'schedules.json'),
      JSON.stringify([
        { id: 'future', enabled: true, schedule, nextRunAt: now + 28801, history },
        { id: 'overdue', enabled: true, schedule, nextRunAt: now - 1, history },
      ]),
    );
    const scheduler = new ExportScheduler(root, {
      taskManager: {} as ExportTaskManager,
      isOnline: () => false,
    });
    try {
      expect(scheduler.get('future')?.nextRunAt).toBe(now + 1);
      expect(scheduler.get('overdue')?.nextRunAt).toBe(now - 1);
      expect(scheduler.get('future')?.history).toEqual(history);
      expect(scheduler.get('overdue')?.history).toEqual(history);
    } finally {
      scheduler.stop();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
