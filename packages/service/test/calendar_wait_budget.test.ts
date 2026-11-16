import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  CALENDAR_BATCH_SIZE,
  ConversationCalendarJob,
  type CalendarSource,
  type CalendarTarget,
} from '../src/account/conversation_calendar';

const day = '2026-11-08';
const time = Date.parse(`${day}T00:00:00+08:00`) / 1000;
const target: CalendarTarget = {
  kind: 'c2c',
  conv: 'synthetic-peer',
  name: '测试',
  avatar: null,
  ancestors: [],
};
const row = (id: string) => ({ conv: target.conv, time, anchor: { id, seq: id, time } });
const jobs: ConversationCalendarJob[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T12:00:00+08:00'));
});
afterEach(async () => {
  for (const job of jobs.splice(0)) {
    job.cancel();
    await vi.runAllTimersAsync();
    await job.settled();
  }
  vi.useRealTimers();
});
function make(source: CalendarSource, sources: CalendarSource[] = []) {
  const job = new ConversationCalendarJob('2026-11', [target], [source, ...sources]);
  jobs.push(job);
  return job;
}
async function finish(job: ConversationCalendarJob) {
  await vi.runAllTimersAsync();
  await job.settled();
}

it('连续等待超时自动退避续查，不缩批、不丢游标和计数、不累计执行失败', async () => {
  let waits = 0;
  const page = vi.fn<CalendarSource['page']>(async (_s, _e, cursor) => {
    if (!cursor) return { rows: [row('1')], cursor: 1, done: false };
    if (waits++ < 4) throw new Error('database_query_wait_timeout');
    return { rows: [row('2')], done: true };
  });
  const job = make({ kind: 'c2c', page, count: async () => 0 });
  job.keepAlive(day);
  await vi.advanceTimersByTimeAsync(30);
  expect(job.snapshot(day).readState?.state).toBe('queued');
  expect(job.snapshot(day).days.find((item) => item.day === day)?.errors).toEqual([]);
  expect(job.snapshot(day).rows[0]?.count).toBe(1);
  await finish(job);
  expect(job.snapshot(day).complete).toBe(true);
  expect(job.snapshot(day).rows[0]?.count).toBe(2);
  expect(page.mock.calls.slice(1).every((call) => call[2] === 1)).toBe(true);
  expect(page.mock.calls.every((call) => call[3] === CALENDAR_BATCH_SIZE)).toBe(true);
  expect(job.metrics).toMatchObject({ waits: 4, timeouts: 0, pauses: 0 });
});

it('COUNT 等待超时不会禁用快捷计数或切到分页扫描', async () => {
  let waits = 0;
  const count = vi.fn<NonNullable<CalendarSource['count']>>(async (start) => {
    if (start !== time) return 0;
    if (waits++ < 4) throw new Error('database_query_wait_timeout');
    return 17;
  });
  const page = vi.fn<CalendarSource['page']>(async () => ({ rows: [], done: true }));
  const job = make({ kind: 'c2c', count, page });
  job.keepAlive();
  await finish(job);
  expect(page).not.toHaveBeenCalled();
  expect(count.mock.calls.filter(([start]) => start === time)).toHaveLength(5);
  expect(job.snapshot().days.find((item) => item.day === day)).toMatchObject({
    count: 17,
    complete: true,
    errors: [],
  });
});

it('COUNT 实际执行超时仍降级为小批分页，不把未完成计数当作完整结果', async () => {
  const count = vi.fn<NonNullable<CalendarSource['count']>>(async (start) => {
    if (start === time) throw new Error('database_query_execution_timeout');
    return 0;
  });
  const page = vi.fn<CalendarSource['page']>(async () => ({ rows: [row('1')], done: true }));
  const job = make({ kind: 'c2c', count, page });
  job.keepAlive();
  await finish(job);
  expect(count.mock.calls.filter(([start]) => start === time)).toHaveLength(1);
  expect(page).toHaveBeenCalledOnce();
  expect(page.mock.calls[0]?.[3]).toBe(CALENDAR_BATCH_SIZE / 2);
  expect(job.snapshot().days.find((item) => item.day === day)).toMatchObject({
    count: 1,
    complete: true,
    errors: [],
  });
});

it('等待超时不占用也不重置真正的连续执行失败次数', async () => {
  let calls = 0;
  const page = vi.fn<CalendarSource['page']>(async () => {
    calls++;
    throw new Error(
      calls >= 3 && calls <= 6 ? 'database_query_wait_timeout' : 'database_query_execution_timeout',
    );
  });
  const job = make({ kind: 'c2c', page, count: async () => 0 });
  job.keepAlive(day);
  await finish(job);
  expect(page).toHaveBeenCalledTimes(7);
  expect(job.metrics).toMatchObject({ waits: 4, timeouts: 3, pauses: 1 });
  expect(job.snapshot(day).days.find((item) => item.day === day)?.errors).toEqual([
    '该来源读取持续超时，统计已暂停',
  ]);
});

it('某个来源等待连接时其他来源继续推进，取消会移除退避定时器', async () => {
  const page = vi.fn<CalendarSource['page']>(async () => {
    throw new Error('database_query_wait_timeout');
  });
  const other = vi.fn<CalendarSource['page']>(async () => ({ rows: [], done: true }));
  const job = make({ kind: 'c2c', page, count: async () => 0 }, [
    { kind: 'group', page: other, count: async () => 0 },
  ]);
  job.keepAlive(day);
  job.continueInBackground();
  await vi.advanceTimersByTimeAsync(1000);
  expect(other).toHaveBeenCalledOnce();
  expect(page.mock.calls.length).toBeLessThan(8);
  expect(job.snapshot(day).controls.day.state).toBe('running');
  expect(job.snapshot(day).canRun).toBe(true);
  const before = page.mock.calls.length;
  job.cancel();
  await job.settled();
  await vi.runAllTimersAsync();
  expect(page).toHaveBeenCalledTimes(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('手动暂停仍阻止等待来源续查，继续后无需重新获取已完成结果', async () => {
  const page = vi.fn<CalendarSource['page']>(async () => {
    throw new Error('database_query_wait_timeout');
  });
  const job = make({ kind: 'c2c', page, count: async () => 0 });
  job.keepAlive(day);
  await vi.advanceTimersByTimeAsync(30);
  job.control('day', 'pause', day);
  const before = page.mock.calls.length;
  await finish(job);
  expect(page).toHaveBeenCalledTimes(before);
  page.mockResolvedValue({ rows: [row('1')], done: true });
  job.control('day', 'continue', day);
  job.keepAlive(day);
  await finish(job);
  expect(job.snapshot(day).complete).toBe(true);
});

it('无关 timeout 错误保留原文，不冒充数据库执行超预算', async () => {
  const page = vi.fn<CalendarSource['page']>(async () => {
    throw new Error('synthetic media timeout');
  });
  const job = make({ kind: 'c2c', page, count: async () => 0 });
  job.keepAlive(day);
  await finish(job);
  expect(page).toHaveBeenCalledOnce();
  expect(job.snapshot(day).days.find((item) => item.day === day)?.errors).toEqual([
    'synthetic media timeout',
  ]);
});

it.each(['读取超出预算，统计已暂停', '该来源读取持续超时，统计已暂停'])(
  '重新打开兼容持久化的「%s」，从原游标续查',
  async (error) => {
    const page = vi.fn<CalendarSource['page']>(async (_s, _e, cursor) => {
      if (!cursor) return { rows: [row('1')], cursor: 1, done: false };
      throw new Error('database_query_execution_timeout');
    });
    const job = make({ kind: 'c2c', page, count: async () => 0 });
    job.keepAlive(day);
    await finish(job);
    const saved = job.checkpoint();
    saved.work.find((task) => task.day === day)!.error = error;
    const read = vi.fn<CalendarSource['page']>(async () => ({ rows: [row('2')], done: true }));
    const restored = make({ kind: 'c2c', page: read, count: async () => 0 });
    expect(restored.restore(saved)).toBe(true);
    restored.retryTimedOut();
    restored.keepAlive(day);
    await finish(restored);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[2]).toBe(1);
    expect(restored.snapshot(day).rows[0]?.count).toBe(2);
    expect(restored.snapshot(day).complete).toBe(true);
  },
);
