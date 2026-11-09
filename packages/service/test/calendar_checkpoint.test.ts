import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ConversationCalendarJob,
  type CalendarBatch,
  type CalendarSource,
  type CalendarTarget,
} from '../src/account/conversation_calendar';
import {
  CalendarCheckpointStore,
  waitForCalendarWrites,
} from '../src/account/conversation_calendar_store';

const target: CalendarTarget = {
  kind: 'c2c',
  conv: 'fixture',
  name: '测试',
  avatar: null,
  ancestors: [],
};
const day = '2026-11-08';
const time = Date.parse(`${day}T00:00:00+08:00`) / 1000;
const row = (id: string) => ({ conv: target.conv, time, anchor: { id, seq: id, time } });
const roots: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T12:00:00+08:00'));
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function finish(job: ConversationCalendarJob) {
  await vi.runAllTimersAsync();
  await job.settled();
}
function make(source: CalendarSource) {
  return new ConversationCalendarJob('2026-11', [target], [source]);
}
it('未选择来源不是零条完成；真正查询得到零条仍完成且始终支持重试', async () => {
  const page = vi.fn(async (): Promise<CalendarBatch> => ({ rows: [], done: true }));
  const job = make({ kind: 'c2c', count: async () => 0, page });
  job.setKinds([]);
  job.keepAlive(day);
  await finish(job);
  expect(page).not.toHaveBeenCalled();
  expect(job.snapshot(day)).toMatchObject({
    complete: false,
    emptyReason: '未选择统计内容',
    controls: { month: { state: 'empty' }, day: { state: 'empty' } },
  });
  expect(job.snapshot(day).days.find((item) => item.day === day)?.complete).toBe(false);
  job.setKinds(['c2c']);
  job.keepAlive(day);
  await finish(job);
  expect(job.snapshot(day)).toMatchObject({
    complete: true,
    controls: {
      month: { state: 'complete', disabled: false },
      day: { state: 'complete', disabled: false },
    },
  });
  expect(job.snapshot(day).days.find((item) => item.day === day)?.count).toBe(0);
  job.control('month', 'pause');
  expect(job.snapshot(day).controls.day.disabled).toBe(false);
  job.control('day', 'retry', day);
  job.keepAlive(day);
  await finish(job);
  expect(page).toHaveBeenCalledTimes(2);
  expect(job.snapshot(day).controls.day.state).toBe('complete');
  job.cancel();
});

it('按日重试保留旧计数和进度，新结果整批完成后替换，减少和锚点变化都能更新', async () => {
  const read = vi.fn(
    async (): Promise<CalendarBatch> => ({ rows: [row('1'), row('2')], done: true }),
  );
  const job = make({ kind: 'c2c', count: async () => 0, page: read });
  job.keepAlive(day);
  await finish(job);
  const before = job.snapshot(day);
  let release!: (page: CalendarBatch) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  read.mockResolvedValueOnce({ rows: [], done: true });
  job.control('day', 'retry', day);
  job.keepAlive(day);
  expect(job.snapshot(day)).toMatchObject({
    refreshing: true,
    hasPending: true,
    progress: before.progress,
    dayProgress: before.dayProgress,
  });
  release({ rows: [row('3')], cursor: 1, done: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(job.snapshot(day).rows[0]?.count).toBe(2);
  expect(job.snapshot(day).rows[0]?.anchor.id).toBe('1');
  const checkpoint = job.checkpoint();
  const saved = checkpoint.work.find((work) => work.day === day)!;
  expect(saved.rows[0]?.count).toBe(2);
  expect(saved.refresh?.rows[0]?.count).toBe(1);
  await finish(job);
  expect(job.snapshot(day)).toMatchObject({ refreshing: false, hasPending: false });
  expect(job.snapshot(day).rows[0]).toMatchObject({ count: 1, anchor: { id: '3' } });
  job.cancel();
});

it('重试失败不覆盖旧结果，再次重试不叠加消息且不泄漏双缓冲预算', async () => {
  const read = vi.fn(async (): Promise<CalendarBatch> => ({ rows: [row('1')], done: true }));
  const job = make({ kind: 'c2c', count: async () => 0, page: read });
  job.keepAlive(day);
  await finish(job);
  const bytes = job.memoryBytes;
  read.mockRejectedValue(new Error('database_query_execution_timeout'));
  job.control('day', 'retry', day);
  job.keepAlive(day);
  await finish(job);
  expect(job.snapshot(day).rows[0]?.count).toBe(1);
  expect(job.snapshot(day).controls.day.state).toBe('failed');
  for (let i = 0; i < 3; i++) {
    read.mockResolvedValue({ rows: [row(String(i + 2))], done: true });
    job.control('day', 'retry', day);
    job.keepAlive(day);
    await finish(job);
    expect(job.snapshot(day).rows[0]?.count).toBe(1);
    expect(job.memoryBytes).toBe(bytes);
  }
  job.cancel();
});

it('月暂停与当日暂停保留成功游标，保存后恢复仍暂停，继续不重复读取已提交页', async () => {
  const cursors: unknown[] = [];
  const source: CalendarSource = {
    kind: 'c2c',
    count: async () => 0,
    page: async (_s, _e, cursor) => {
      cursors.push(cursor);
      return { rows: [row(cursor ? '2' : '1')], cursor: 1, done: Boolean(cursor) };
    },
  };
  const job = make(source);
  job.keepAlive(day);
  await vi.advanceTimersByTimeAsync(0);
  job.control('day', 'pause', day);
  await vi.advanceTimersByTimeAsync(100);
  expect(cursors).toEqual([undefined]);
  expect(job.snapshot(day).controls.month.state).toBe('running');
  const restored = make(source);
  expect(restored.restore(job.checkpoint())).toBe(true);
  restored.keepAlive(day);
  await vi.advanceTimersByTimeAsync(100);
  expect(cursors).toEqual([undefined]);
  restored.control('month', 'pause');
  restored.control('day', 'continue', day);
  restored.keepAlive(day);
  await vi.advanceTimersByTimeAsync(100);
  expect(restored.snapshot(day).controls.day.disabled).toBe(false);
  expect(restored.checkpoint().monthPaused).toBe(true);
  expect(cursors).toEqual([undefined, 1]);
  restored.control('month', 'continue');
  restored.keepAlive(day);
  await finish(restored);
  expect(cursors).toEqual([undefined, 1]);
  expect(restored.snapshot(day).rows[0]?.count).toBe(2);
  job.cancel();
  restored.cancel();
  await finish(job);
});

it('整月重试不清空已完成数量，检查点恢复后仍能展示已算过的日期', async () => {
  const source: CalendarSource = {
    kind: 'c2c',
    count: async () => 0,
    page: async () => ({ rows: [row('1')], done: true }),
  };
  const job = make(source);
  job.keepAlive(day);
  await finish(job);
  const original = job.snapshot(day);
  job.control('month', 'retry');
  expect(job.snapshot(day).progress).toEqual(original.progress);
  expect(job.snapshot(day).rows[0]?.count).toBe(1);
  const restored = make(source);
  expect(restored.restore(job.checkpoint())).toBe(true);
  expect(restored.snapshot(day).progress).toEqual(original.progress);
  expect(restored.snapshot(day).refreshing).toBe(true);
  restored.keepAlive(day);
  await finish(restored);
  expect(restored.snapshot(day).rows[0]?.count).toBe(1);
  restored.keepAlive('2026-11-07');
  await finish(restored);
  expect(restored.snapshot(day).rows[0]?.count).toBe(1);
  job.cancel();
  restored.cancel();
});
it('暂停当月不停止当前日，当前日完成后不自动扩展到其他日期', async () => {
  const count = vi.fn(async () => 0);
  const page = vi.fn(async (_s: number, _e: number, cursor: unknown): Promise<CalendarBatch> => ({ rows: [row(cursor ? '2' : '1')], cursor: 1, done: Boolean(cursor) }));
  const job = make({ kind: 'c2c', count, page });
  job.keepAlive(day); await vi.advanceTimersByTimeAsync(0);
  job.control('month', 'pause'); await finish(job);
  expect(page).toHaveBeenCalledTimes(2);
  expect(count).not.toHaveBeenCalled();
  expect(job.snapshot(day).rows[0]?.count).toBe(2);
  expect(job.snapshot(day).controls.month.state).toBe('paused');
  expect(job.snapshot(day).controls.day.state).toBe('complete');
  expect(job.checkpoint().pausedDays).toEqual([]);
  job.cancel();
});

it('今天暂停时月统计从昨天往月初，月暂停仍能继续当日，两层状态分别持久保存', async () => {
  vi.setSystemTime(new Date('2026-11-08T12:00:00+08:00'));
  const starts: number[] = [];
  const source: CalendarSource = {
    kind: 'c2c',
    count: async () => null,
    page: async (start) => {
      starts.push(start);
      return { rows: start === time ? [row('1')] : [], done: true };
    },
  };
  const job = make(source);
  job.control('day', 'pause', day);
  job.keepAlive(day);
  await finish(job);
  expect(starts).toEqual(Array.from({ length: 7 }, (_, index) => time - (index + 1) * 86400));
  expect(job.checkpoint()).toMatchObject({ monthPaused: false, pausedDays: [day] });
  expect(job.snapshot(day).controls.month.state).toBe('running');
  const restored = make(source);
  expect(restored.restore(job.checkpoint())).toBe(true);
  restored.control('month', 'pause');
  restored.control('day', 'continue', day);
  restored.keepAlive(day);
  await finish(restored);
  expect(starts.at(-1)).toBe(time);
  expect(restored.checkpoint().monthPaused).toBe(true);
  expect(restored.snapshot(day).rows[0]?.count).toBe(1);
  restored.control('day', 'pause', '2026-11-07');
  restored.control('month', 'continue');
  expect(restored.checkpoint().pausedDays).toContain('2026-11-07');
  const otherMonth = new ConversationCalendarJob('2026-10', [], []);
  expect(otherMonth.checkpoint().monthPaused).toBe(false);
  expect(otherMonth.checkpoint().pausedDays).toEqual([]);
  job.cancel();
  restored.cancel();
  otherMonth.cancel();
});

it('原子保存后新实例恢复结果，账号和数据源隔离；坏文件保留，不静默覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-calendar-checkpoint-'));
  roots.push(root);
  const source: CalendarSource = {
    kind: 'c2c',
    count: async () => 0,
    page: async () => ({ rows: [row('1')], done: true }),
  };
  const job = make(source);
  job.keepAlive(day);
  await finish(job);
  const store = new CalendarCheckpointStore(root, 'account-A:source-A:month', () =>
    job.checkpoint(),
  );
  await store.flush();
  await waitForCalendarWrites();
  const next = new CalendarCheckpointStore(root, 'account-A:source-A:month', () =>
    job.checkpoint(),
  );
  const restored = make(source);
  expect(restored.restore(await next.load())).toBe(true);
  expect(restored.snapshot(day).rows[0]?.count).toBe(1);
  expect(
    await new CalendarCheckpointStore(root, 'account-A:source-B:month', () =>
      job.checkpoint(),
    ).load(),
  ).toBeUndefined();
  expect(
    await new CalendarCheckpointStore(root, 'account-B:source-A:month', () =>
      job.checkpoint(),
    ).load(),
  ).toBeUndefined();
  await writeFile(store.path, '{broken');
  const errors: Array<string | undefined> = [];
  const broken = new CalendarCheckpointStore(
    root,
    'account-A:source-A:month',
    () => job.checkpoint(),
    (message) => errors.push(message),
  );
  expect(await broken.load()).toBeUndefined();
  await broken.flush();
  expect(await readFile(store.path, 'utf8')).toBe('{broken');
  expect(errors.at(-1)).toContain('原文件已保留');
  job.cancel();
  restored.cancel();
});

it('无效检查点整份拒绝，不部分提交错误计数或超范围游标', () => {
  const source: CalendarSource = { kind: 'c2c', page: async () => ({ rows: [], done: true }) };
  const job = make(source),
    state = job.checkpoint();
  state.work[1]!.count = -1;
  expect(job.restore(state)).toBe(false);
  expect(job.snapshot(day).progress.completedSources).toBe(0);
  const other = job.checkpoint();
  other.month = '2026-10';
  expect(job.restore(other)).toBe(false);
  job.cancel();
});

it('重新获取的中间游标持久恢复，继续后不混入旧消息或重复计数', async () => {
  let rechecking = false;
  const source: CalendarSource = {
    kind: 'c2c',
    count: async () => 0,
    page: async () =>
      rechecking
        ? { rows: [row('3')], cursor: 2, done: false }
        : { rows: [row('1'), row('2')], done: true },
  };
  const job = make(source);
  job.keepAlive(day);
  await finish(job);
  rechecking = true;
  job.control('day', 'retry', day);
  job.keepAlive(day);
  await vi.advanceTimersByTimeAsync(0);
  job.control('day', 'pause', day);
  await vi.advanceTimersByTimeAsync(20);
  const saved = job.checkpoint();
  job.cancel();
  const read = vi.fn(async (_s: number, _e: number, cursor: unknown): Promise<CalendarBatch> => {
    expect(cursor).toBe(2);
    return { rows: [row('4')], done: true };
  });
  const restored = make({ kind: 'c2c', count: async () => 0, page: read });
  expect(restored.restore(saved)).toBe(true);
  expect(restored.snapshot(day).rows[0]).toMatchObject({ count: 2, anchor: { id: '1' } });
  restored.control('day', 'continue', day);
  restored.keepAlive(day);
  await finish(restored);
  expect(read).toHaveBeenCalledTimes(1);
  expect(restored.snapshot(day).rows[0]).toMatchObject({ count: 2, anchor: { id: '3' } });
  restored.cancel();
});
