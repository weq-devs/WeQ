import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  calendarMonthDays,
  calendarTargetKey,
  ConversationCalendarJob,
  filterCalendarTargets,
  type CalendarSource,
  type CalendarTarget,
} from '../src/account/conversation_calendar';

const target: CalendarTarget = {
  kind: 'c2c',
  conv: 'u_peer',
  name: '朋友',
  avatar: null,
  ancestors: ['隐藏会话', '12345'],
};
const day = '2026-11-08';
const start = Date.parse(`${day}T00:00:00+08:00`) / 1000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T12:00:00+08:00'));
});
afterEach(() => {
  vi.useRealTimers();
});
const message = (id: string, time = start, conv = target.conv) => ({
  conv,
  time,
  anchor: { id, seq: id, time },
});
async function finish(job: ConversationCalendarJob) {
  await vi.runAllTimersAsync();
  await job.settled();
}

it('北京时间跨月与闰年边界准确，不使用本机时区', () => {
  expect(calendarMonthDays('2024-02')).toHaveLength(29);
  expect(calendarMonthDays('2026-11')[0]?.start).toBe(Date.parse('2026-10-31T16:00:00Z') / 1000);
  expect(() => calendarMonthDays('2026-13')).toThrow();
});
it('日志动态更新批次数量、不刷屏，并保留有界的完成回执', async () => {
  let processed = 0;
  const job = new ConversationCalendarJob(
    '2026-11',
    [target],
    [
      {
        kind: 'c2c',
        count: async () => 0,
        page: async () => {
          processed++;
          return {
            rows: [message(String(processed))],
            cursor: processed,
            done: processed === 3,
            progress: { phase: '本地元数据', processed, unit: '条元数据' },
          };
        },
      },
    ],
  );
  job.keepAlive(day);
  await vi.advanceTimersByTimeAsync(0);
  const initial = job.snapshot(day, 0, true).logs!.at(-1)!;
  expect(initial.text).toContain('已计 1 条消息');
  await vi.advanceTimersByTimeAsync(20);
  const next = job.snapshot(day, 0, true).logs!.at(-1)!;
  expect(next.seq).toBe(initial.seq);
  expect(next.text).toContain('已计 2 条消息');
  expect(job.snapshot(day).logs).toBeUndefined();
  await finish(job);
  const snapshot = job.snapshot(day, 0, true);
  expect(snapshot.logs!.length).toBeLessThanOrEqual(200);
  expect(snapshot.logs!.at(-1)!.text).toContain('本轮统计完成');
  expect(snapshot.progress).toEqual({ completedSources: 30, totalSources: 30, failedSources: 0 });
});
it('选中日最先统计，随后先近的过去再未来，来源顺序固定', async () => {
  const calls: string[] = [];
  const record = (kind: string, start: number) =>
    calls.push(`${new Date((start + 8 * 3600) * 1000).toISOString().slice(0, 10)}:${kind}`);
  const sources: CalendarSource[] = (['group', 'c2c'] as const).map((kind) => ({
    kind,
    count: async (start) => {
      record(kind, start);
      return 0;
    },
    page: async (start) => {
      record(kind, start);
      return { rows: [], done: true };
    },
  }));
  const job = new ConversationCalendarJob('2026-11', [], sources);
  job.keepAlive('2026-11-10');
  await finish(job);
  expect(calls.slice(0, 6)).toEqual([
    '2026-11-10:c2c',
    '2026-11-10:group',
    '2026-11-09:c2c',
    '2026-11-09:group',
    '2026-11-08:c2c',
    '2026-11-08:group',
  ]);
  expect(calls.indexOf('2026-11-01:c2c')).toBeLessThan(calls.indexOf('2026-11-11:c2c'));
  expect(job.snapshot('2026-11-10').dayProgress).toMatchObject({
    completedSources: 2,
    totalSources: 2,
  });
});
it('缓存空间不足时整批不提交，不产生部分提交后的重数', async () => {
  let reservations = 0;
  const job = new ConversationCalendarJob(
    '2026-11',
    [target],
    [
      {
        kind: 'c2c',
        count: async () => 0,
        page: async () => ({ rows: [message('1'), message('2')], done: true }),
      },
    ],
    () => ++reservations === 1,
  );
  job.keepAlive(day);
  await finish(job);
  expect(job.snapshot(day).rows).toEqual([]);
  expect(
    job
      .snapshot(day)
      .days.find((row) => row.day === day)
      ?.errors.join(),
  ).toContain('缓存');
});
it('相同对象号的不同来源分开计数，最早锚点保留所属克隆子会话', async () => {
  const clone = { ...target, kind: 'persona' as const };
  const sources: CalendarSource[] = [
    { kind: 'c2c', count: async () => 0, page: async () => ({ rows: [message('1')], done: true }) },
    {
      kind: 'persona',
      count: async () => 0,
      page: async () => ({
        rows: [
          {
            ...message('uuid'),
            anchor: { id: 'uuid', seq: '', time: start, sessionId: 'old-session' },
          },
        ],
        done: true,
      }),
    },
  ];
  const job = new ConversationCalendarJob('2026-11', [target, clone], sources);
  job.keepAlive(day);
  await finish(job);
  expect(job.snapshot(day).days.find((row) => row.day === day)?.count).toBe(2);
  expect(job.snapshot(day).rows).toHaveLength(2);
  expect(job.anchor(clone, 'uuid')?.sessionId).toBe('old-session');
  expect(job.anchor(target, 'uuid')).toBeUndefined();
});
it('筛选完整对象、展开聚合别名并按来源身份去重', () => {
  const clone = { ...target, kind: 'persona' as const };
  expect(
    filterCalendarTargets([target, target, clone], 'real', '隐藏').map(calendarTargetKey),
  ).toEqual(['c2c:u_peer']);
  expect(filterCalendarTargets([target, clone], 'virtual', '12345')).toEqual([clone]);
  expect(filterCalendarTargets([target], 'guild', '')).toEqual([]);
});
it('严格跟随外部聚合入口匹配，频道独立范围才按子会话名称搜索', () => {
  const hidden = {
    ...target,
    searchText: '朋友 12345',
    listingSearchText: '隐藏会话 merged:hidden ',
  };
  const guild = {
    ...hidden,
    kind: 'guild' as const,
    listingSearchText: '频道私聊 merged:guild-direct ',
  };
  expect(filterCalendarTargets([hidden], 'all', '朋友')).toEqual([]);
  expect(filterCalendarTargets([hidden], 'all', '隐藏会话')).toEqual([hidden]);
  expect(filterCalendarTargets([guild], 'all', '朋友')).toEqual([]);
  expect(filterCalendarTargets([guild], 'guild', '朋友')).toEqual([guild]);
});
it('逐批详情和每日计数一致，只计当前日期，正确处理 UUID 定位', async () => {
  const source: CalendarSource = {
    kind: 'c2c',
    count: async () => 0,
    page: async () => ({
      rows: [message('uuid-b'), message('uuid-a'), message('out', start - 1)],
      done: true,
    }),
  };
  const job = new ConversationCalendarJob('2026-11', [target], [source]);
  job.keepAlive(day);
  await finish(job);
  const snapshot = job.snapshot(day);
  expect(snapshot.complete).toBe(true);
  expect(snapshot.days.find((row) => row.day === day)?.count).toBe(2);
  expect(snapshot.rows[0]?.count).toBe(2);
  expect(snapshot.rows[0]?.anchor.id).toBe('uuid-a');
});
it('滚动扩展返回窗口不触发重新扫描，保留完整排序及默认兼容窗口', async () => {
  const targets = Array.from({ length: 180 }, (_, index) => ({
    ...target,
    conv: `peer-${String(index).padStart(3, '0')}`,
  }));
  const page = vi.fn(async () => ({
    rows: targets.map((item, index) => message(String(index), start, item.conv)),
    done: true,
  }));
  const job = new ConversationCalendarJob('2026-11', targets, [
    { kind: 'c2c', page, count: async () => 0 },
  ]);
  job.keepAlive(day);
  await finish(job);
  expect(job.snapshot(day).rows).toHaveLength(50);
  expect(job.snapshot(day, 0, false, 100).rows).toHaveLength(100);
  const all = job.snapshot(day, 0, false, 200);
  expect(all.rows).toHaveLength(180);
  expect(all.totalRows).toBe(180);
  expect(new Set(all.rows.map((row) => row.target.conv)).size).toBe(180);
  expect(page).toHaveBeenCalledTimes(1);
});
it('COUNT 超时降级，分页超时不提交游标或重复条数', async () => {
  let attempts = 0;
  const page = vi.fn(async (_start, _end, cursor) => {
    if (cursor === 1 && attempts++ === 0) throw new Error('database_query_execution_timeout');
    return cursor === 1
      ? { rows: [message('2')], done: true }
      : { rows: [message('1')], cursor: 1, done: false };
  });
  const source: CalendarSource = { kind: 'c2c', count: async () => 0, page };
  const job = new ConversationCalendarJob('2026-11', [target], [source]);
  job.keepAlive(day);
  await finish(job);
  expect(job.snapshot(day).rows[0]?.count).toBe(2);
  expect(job.metrics.timeouts).toBe(1);
});
it('三次无法推进暂停来源，结果不是完整零值，重试不丢已完成结果', async () => {
  const page = vi.fn(async () => {
    throw new Error('database_query_execution_timeout');
  });
  const job = new ConversationCalendarJob(
    '2026-11',
    [target],
    [{ kind: 'c2c', count: async () => 0, page }],
  );
  job.keepAlive(day);
  await finish(job);
  expect(page).toHaveBeenCalledTimes(3);
  expect(job.snapshot(day).days.find((row) => row.day === day)?.complete).toBe(false);
  expect(job.snapshot(day).days.find((row) => row.day === day)?.errors).not.toEqual([]);
});
it('关闭时丢弃在途页，后续不再提交查询', async () => {
  let resolve!: (value: { rows: ReturnType<typeof message>[]; done: boolean }) => void;
  const page = vi.fn(
    () =>
      new Promise<{ rows: ReturnType<typeof message>[]; done: boolean }>((done) => {
        resolve = done;
      }),
  );
  const job = new ConversationCalendarJob('2026-11', [target], [{ kind: 'c2c', page }]);
  job.keepAlive(day);
  job.cancel();
  resolve({ rows: [message('1')], done: true });
  await finish(job);
  expect(page).toHaveBeenCalledTimes(1);
  expect(job.snapshot(day).rows).toEqual([]);
});
it('客户端不续租时，即使正在等待读取也会取消任务', async () => {
  const page = vi.fn(
    () =>
      new Promise<{ rows: never[]; done: boolean }>((resolve) => {
        job.controller.signal.addEventListener('abort', () => resolve({ rows: [], done: true }), {
          once: true,
        });
      }),
  );
  const job = new ConversationCalendarJob('2026-11', [target], [{ kind: 'c2c', page }]);
  job.keepAlive(day);
  await finish(job);
  expect(job.snapshot(day).cancelled).toBe(true);
  expect(page).toHaveBeenCalledTimes(1);
});
it('明确转入后台才可在不续租时继续超过五秒，完成后不残留周期任务', async () => {
  let processed = 0;
  const changed = vi.fn();
  const job = new ConversationCalendarJob(
    '2026-11',
    [target],
    [
      {
        kind: 'c2c',
        count: async () => 0,
        page: async () => {
          processed++;
          return { rows: [message(String(processed))], cursor: processed, done: processed === 300 };
        },
      },
    ],
    undefined,
    changed,
  );
  job.keepAlive(day);
  job.continueInBackground();
  await finish(job);
  expect(processed).toBe(300);
  expect(job.snapshot(day).cancelled).toBe(false);
  expect(job.snapshot(day).complete).toBe(true);
  expect(job.snapshot(day).rows[0]?.count).toBe(300);
  expect(changed).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('仅有快速计数时不冒称当天会话列表完整，空来源可以确认为零', async () => {
  const job = new ConversationCalendarJob(
    '2026-11',
    [target],
    [{ kind: 'c2c', count: async () => 7, page: async () => ({ rows: [], done: true }) }],
  );
  job.keepAlive();
  await finish(job);
  expect(job.snapshot(day).complete).toBe(false);
  expect(job.snapshot(day).days.find((row) => row.day === day)?.count).toBe(7);
  expect(
    new ConversationCalendarJob('2026-11', [], [])
      .snapshot(day)
      .days.every((row) => row.complete && row.count === 0),
  ).toBe(true);
});
