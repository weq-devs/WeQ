import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  calendarMonthDays,
  CALENDAR_SOURCE_ORDER,
  type CalendarTarget,
} from '@weq/service/conversation-calendar';
import { ConversationOverviewCalendar } from '../src/renderer/src/components/ConversationOverviewCalendar';
import {
  calendarCloneRevision,
  calendarAssistantRevision,
} from '../src/renderer/src/lib/calendarSourceRevision';
import { setCalendarKinds } from '../src/renderer/src/hooks/useCalendarKinds';
import type { CalendarControlState } from '@weq/service/conversation-calendar';

const fixture = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  poll: vi.fn(),
  background: vi.fn(),
  control: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      calendarOverview: {
        start: { mutate: fixture.start },
        stop: { mutate: fixture.stop },
        poll: { query: fixture.poll },
        locate: { mutate: vi.fn() },
        background: { mutate: fixture.background },
        control: { mutate: fixture.control },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../src/renderer/src/components/RetainedTabs', () => ({ useTabActive: () => true }));

const month = '2026-11';
function snapshot(complete: boolean, selectedMonth = month) {
  return {
    controls: {
      month: {
        state: (complete ? 'complete' : 'running') as CalendarControlState,
        disabled: false,
      },
      day: { state: (complete ? 'complete' : 'running') as CalendarControlState, disabled: false },
    },
    hasPending: !complete,
    emptyReason: undefined as string | undefined,
    enabledKinds: [...CALENDAR_SOURCE_ORDER],
    readState: undefined as { state: 'idle' | 'queued' | 'reading'; since: number } | undefined,
    days: calendarMonthDays(selectedMonth).map(({ day }) => ({
      day,
      count: day === '2026-11-10' ? 42 : 0,
      complete: complete || day === '2026-11-10',
      errors: [] as string[],
    })),
    rows: [],
    totalRows: 0,
    complete,
    cancelled: false,
    metrics: { batches: 1, reads: 1, timeouts: 0, pauses: 0, maxBatchMs: 1, maxNativeAwaitMs: 1 },
  };
}
let state = snapshot(false);
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    length: 0,
    key: () => null,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00+08:00'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  state = snapshot(false);
  fixture.background.mockReset().mockResolvedValue({ taskId: 'background-fixture' });
  fixture.start
    .mockReset()
    .mockImplementation(async () => ({ id: `job-${fixture.start.mock.calls.length}` }));
  fixture.stop.mockReset().mockResolvedValue(true);
  fixture.poll.mockReset().mockImplementation(async () => structuredClone(state));
  fixture.control.mockReset().mockImplementation(async () => structuredClone(state));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const defaultTargets: CalendarTarget[] = [
  { kind: 'group', conv: '42', name: 'fixture', avatar: null, ancestors: [] },
];
it('统计内容聚焦后 Escape 不清空记忆选择，也不拦住外层关闭处理', async () => {
  const view = mount();
  try {
    await tick();
    const option = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === '私聊',
    )!;
    act(() => option.focus());
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => option.dispatchEvent(event));
    await tick();
    expect(event.defaultPrevented).toBe(false);
    expect(option.getAttribute('aria-pressed')).toBe('true');
    expect(fixture.poll.mock.lastCall?.[0].kinds).toContain('c2c');
    expect(fixture.start).toHaveBeenCalledTimes(1);
  } finally {
    view.close();
  }
});
it('空选择不显示零条完成或满进度，重新选择后在同一任务中获取', async () => {
  setCalendarKinds([]);
  state.enabledKinds = [];
  state.emptyReason = '未选择统计内容';
  state.controls = {
    month: { state: 'empty', disabled: true },
    day: { state: 'empty', disabled: true },
  };
  state.hasPending = false;
  state.days = state.days.map((item) => ({
    ...item,
    count: 0,
    complete: false,
    emptyReason: '未选择统计内容',
  }));
  const view = mount();
  try {
    await tick();
    expect(view.host.textContent).toContain('未选择统计内容');
    expect(view.host.textContent).not.toContain('当天没有消息');
    expect(
      view.host
        .querySelector<HTMLButtonElement>('[aria-label="2026-11-10，未选择统计内容"]')
        ?.querySelector('small')?.textContent,
    ).toBe('');
    expect(
      [...view.host.querySelectorAll('progress')].every(
        (item) => item.getAttribute('value') === '0',
      ),
    ).toBe(true);
    const calls = fixture.poll.mock.calls.length;
    await tick(2000);
    expect(fixture.poll).toHaveBeenCalledTimes(calls);
    state = snapshot(false);
    act(() => setCalendarKinds(['c2c']));
    await tick();
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.poll.mock.lastCall?.[0].kinds).toEqual(['c2c']);
  } finally {
    view.close();
  }
});
it('完成后从进度条重试沿用原句柄，并重新开始轮询而不创建新任务', async () => {
  state = snapshot(true);
  const view = mount();
  try {
    await tick();
    state = snapshot(false);
    const retry = view.host.querySelector<HTMLButtonElement>('[aria-label="重试当月统计"]')!;
    act(() => retry.click());
    await tick();
    expect(fixture.control).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1', scope: 'month', action: 'retry' }),
    );
    expect(fixture.start).toHaveBeenCalledTimes(1);
    const reads = fixture.poll.mock.calls.length;
    await tick(1000);
    expect(fixture.poll.mock.calls.length).toBeGreaterThan(reads);
  } finally {
    view.close();
  }
});
it('北京时间今天之后置灰且不可选择，不显示待统计省略号或未来计数', async () => {
  const view = mount();
  try {
    await tick();
    const future = view.host.querySelector<HTMLButtonElement>(
      '[aria-label="2026-11-11，未来日期不统计"]',
    )!;
    expect(future.disabled).toBe(true);
    expect(future.classList.contains('is-future')).toBe(true);
    expect(future.querySelector('small')?.textContent).toBe('');
    expect(
      view.host.querySelector<HTMLButtonElement>('[aria-label="2026-11-10，42 条消息"]')?.disabled,
    ).toBe(false);
    const previous = fixture.poll.mock.lastCall?.[0].day;
    act(() => future.click());
    await tick();
    expect(fixture.poll.mock.lastCall?.[0].day).toBe(previous);
  } finally {
    view.close();
  }
});
it('零次原生读取不再冒充等待空闲，实际排队状态明确显示', async () => {
  state.metrics.reads = 0;
  state.readState = { state: 'queued', since: Date.now() };
  const view = mount();
  try {
    await tick();
    expect(view.host.textContent).toContain('等待前序数据库查询结束');
    expect(view.host.textContent).not.toContain('等待数据库空闲');
  } finally {
    view.close();
  }
});

it('统计来源选择记忆，切换只轮询原任务而不重建', async () => {
  let view = mount();
  try {
    await tick();
    const option = [...view.host.querySelectorAll('button')].find(
      (item) => item.textContent === '私聊',
    )!;
    act(() => option.click());
    await tick();
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.poll.mock.lastCall?.[0].kinds).not.toContain('c2c');
    view.close();
    view = mount();
    await tick();
    expect(fixture.start.mock.lastCall?.[0].kinds).not.toContain('c2c');
    expect(
      [...view.host.querySelectorAll('button')]
        .find((item) => item.textContent === '私聊')!
        .getAttribute('aria-pressed'),
    ).toBe('false');
    expect(view.host.textContent).toContain('我的设备');
    expect(view.host.textContent).toContain('公众号/服务号');
    expect(view.host.textContent).toContain('克隆会话');
  } finally {
    view.close();
  }
});
it('日历使用连续滚动会话列表，不显示分页入口', async () => {
  const view = mount();
  try {
    await tick();
    expect(view.host.querySelector('[aria-label="会话分页"]')).toBeNull();
    expect(view.host.querySelector('button[aria-label="任务日志"]')).toBeNull();
  } finally {
    view.close();
  }
});
it('后台进行复用当前月份任务，关闭日历不再取消；普通关闭仍停止', async () => {
  const view = mount();
  try {
    await tick();
    expect(view.host.querySelector('[aria-label="重新统计"]')).toBeNull();
    const button = [...view.host.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('后台进行'),
    )!;
    expect(button.disabled).toBe(false);
    act(() => button.click());
    await tick();
    expect(fixture.background).toHaveBeenCalledTimes(1);
    expect(fixture.background.mock.calls[0]?.[0].id).toBe('job-1');
  } finally {
    view.close();
  }
  expect(fixture.stop).not.toHaveBeenCalled();
});
it('后台交接失败时显示错误，直接关闭仍然停止任务', async () => {
  fixture.background.mockRejectedValueOnce(new Error('交接失败'));
  const view = mount();
  try {
    await tick();
    const button = [...view.host.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('后台进行'),
    )!;
    act(() => button.click());
    await tick();
    expect(view.host.textContent).toContain('交接失败');
    expect(button.disabled).toBe(false);
  } finally {
    view.close();
  }
  expect(fixture.stop).toHaveBeenCalledTimes(1);
});
it('日历中同样通过任务日志折叠栏展开，按需读取且不重建统计', async () => {
  const view = mount();
  try {
    await tick();
    const button = view.host.querySelector<HTMLButtonElement>('.weq-exp-detail-tasklog-head')!;
    expect(button.closest('.weq-overview-calendar-conversations')).not.toBeNull();
    expect(
      view.host.querySelector(
        '.weq-overview-calendar-conversations .weq-overview-calendar-progress',
      ),
    ).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(fixture.poll.mock.calls.at(-1)?.[0].includeLogs).toBe(false);
    act(() => button.click());
    await tick();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.poll.mock.calls.at(-1)?.[0].includeLogs).toBe(true);
    expect(fixture.start).toHaveBeenCalledTimes(1);
  } finally {
    view.close();
  }
});
it('再次点击当前日期不清空已完成的当天会话状态', async () => {
  state = snapshot(true);
  const view = mount();
  try {
    await tick();
    const status = view.host.querySelector(
      '.weq-overview-calendar-conversations p[role="status"]',
    )!;
    expect(status.textContent).toBe('0 个会话');
    act(() =>
      view.host.querySelector<HTMLButtonElement>('[aria-label="2026-11-10，42 条消息"]')!.click(),
    );
    await tick();
    expect(status.textContent).toBe('0 个会话');
  } finally {
    view.close();
  }
});
function mount(initialTargets = defaultTargets) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (sourceRevision: string, targets = initialTargets) =>
    act(() =>
      root.render(
        createElement(ConversationOverviewCalendar, {
          targets,
          scope: 'all',
          query: '',
          ready: true,
          binding: { expectedAccountUin: 'fixture', expectedAccountConfigId: 'fixture' },
          sourceRevision,
          onClose: () => {},
          onLocate: () => {},
        }),
      ),
    );
  render('a');
  return {
    host,
    render,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('扫描期间的数据通知不遮住已完成数字，也不陷入等待重新统计', async () => {
  const view = mount();
  try {
    await tick();
    view.render('b');
    await tick(6000);
    const date = view.host.querySelector<HTMLButtonElement>('[aria-label="2026-11-10，42 条消息"]');
    expect(date?.querySelector('small')?.textContent).toBe('42');
    expect(view.host.textContent).not.toContain('等待重新统计');
    expect(fixture.start).toHaveBeenCalledTimes(1);
  } finally {
    view.close();
  }
});
it('会话因新消息重排、头像和名称更新不会重建相同统计范围', async () => {
  const a = defaultTargets[0]!,
    b = { ...a, conv: '43', name: 'second' };
  const view = mount([a, b]);
  try {
    await tick();
    view.render('b', [b, { ...a, name: 'renamed', avatar: 'https://example.invalid/avatar' }]);
    await tick(1000);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    view.render('c', [b]);
    await tick();
    expect(fixture.start).toHaveBeenCalledTimes(2);
  } finally {
    view.close();
  }
});
it('创建任务即传入选中日，而不是先启动月底扫描再等轮询纠正', async () => {
  const view = mount();
  try {
    await tick();
    expect(fixture.start.mock.lastCall?.[0]).toMatchObject({ month: '2026-11', day: '2026-11-10' });
  } finally {
    view.close();
  }
});

it('统计完成后合并一次刷新，刷新期间的新通知不导致整月循环重扫', async () => {
  state = snapshot(true);
  const view = mount();
  try {
    await tick();
    view.render('b');
    await tick();
    state = snapshot(false);
    await tick(5000);
    await tick();
    expect(fixture.start).toHaveBeenCalledTimes(2);
    view.render('c');
    await tick(500);
    state = snapshot(true);
    await tick(15000);
    await tick();
    expect(fixture.start).toHaveBeenCalledTimes(2);
    expect(view.host.textContent).not.toContain('等待重新统计');
  } finally {
    view.close();
  }
});

it('来源暂停时显示具体状态，不等待永远无法完成的整月刷新', async () => {
  state.days[0]!.complete = false;
  state.days[0]!.errors = ['统计已暂停，点击重试'];
  const view = mount();
  try {
    await tick();
    view.render('b');
    await tick(10000);
    expect(view.host.textContent).toContain('统计已暂停，点击重试');
    expect(view.host.textContent).not.toContain('等待重新统计');
    expect(fixture.start).toHaveBeenCalledTimes(1);
  } finally {
    view.close();
  }
});
it('相同内容的目录重新拉取和顺序改变不算更新，实际消息变化才算', () => {
  const rows = [
    { id: 'a', updatedAt: 1, lastMessageTime: 2, preview: 'old', dataUpdatedAt: 100 },
    { id: 'b', updatedAt: 2 },
  ];
  const original = calendarCloneRevision(rows, []);
  expect(
    calendarCloneRevision(
      [...rows].reverse().map((row) => ({ ...row, dataUpdatedAt: 200 })),
      [],
    ),
  ).toBe(original);
  expect(calendarCloneRevision([{ ...rows[0]!, preview: 'new' }, rows[1]!], [])).not.toBe(original);
});

it('助手日历的来源版本只跟随各独立会话内容时间，目录重排不触发重新扫描', () => {
  const rows = [
    { id: 'one', updatedAt: 1 },
    { id: 'two', updatedAt: 2 },
  ];
  const original = calendarAssistantRevision(rows);
  expect(calendarAssistantRevision([...rows].reverse())).toBe(original);
  expect(calendarAssistantRevision([{ ...rows[0]!, updatedAt: 3 }, rows[1]!])).not.toBe(original);
  expect(calendarAssistantRevision([rows[1]!])).not.toBe(original);
});

it('扫描中的数据变更不重开任务，直接关闭后停止且没有轮询或自动重启', async () => {
  const view = mount();
  await tick();
  view.render('b');
  await tick();
  expect(fixture.start).toHaveBeenCalledTimes(1);
  view.close();
  const calls = fixture.poll.mock.calls.length;
  await tick(15000);
  expect(fixture.poll).toHaveBeenCalledTimes(calls);
  expect(fixture.start).toHaveBeenCalledTimes(1);
  expect(fixture.stop).toHaveBeenCalledTimes(1);
});

function nextMonth(host: HTMLElement) {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="下个月"]')!.click());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('切月创建任务期间不把新月份日期发给旧任务', async () => {
  const pending = deferred<{ id: string }>();
  const months = new Map([
    ['job-nov', '2026-11'],
    ['job-dec', '2026-12'],
  ]);
  fixture.start.mockImplementation((input: { month: string }) =>
    input.month === '2026-11' ? Promise.resolve({ id: 'job-nov' }) : pending.promise,
  );
  fixture.poll.mockImplementation(async (input: { id: string; day?: string }) => {
    const taskMonth = months.get(input.id)!;
    if (input.day && !input.day.startsWith(`${taskMonth}-`)) throw new Error('日期不属于当前月份');
    return snapshot(false, taskMonth);
  });
  const view = mount();
  try {
    await tick();
    nextMonth(view.host);
    await tick();
    expect(
      fixture.poll.mock.calls.every(
        ([input]) => !input.day || input.day.startsWith(`${months.get(input.id)}-`),
      ),
    ).toBe(true);
    pending.resolve({ id: 'job-dec' });
    await tick();
    expect(view.host.textContent).not.toContain('日期不属于当前月份');
    expect(fixture.poll.mock.lastCall?.[0]).toMatchObject({ id: 'job-dec', day: '2026-12-01' });
  } finally {
    view.close();
  }
});

it('快速跨年切月时丢弃迟到任务，不重启旧月份轮询', async () => {
  const december = deferred<{ id: string }>(),
    january = deferred<{ id: string }>();
  const months = new Map([
    ['job-nov', '2026-11'],
    ['job-dec', '2026-12'],
    ['job-jan', '2027-01'],
  ]);
  fixture.start.mockImplementation((input: { month: string }) =>
    input.month === '2026-11'
      ? Promise.resolve({ id: 'job-nov' })
      : input.month === '2026-12'
        ? december.promise
        : january.promise,
  );
  fixture.poll.mockImplementation(async (input: { id: string; day?: string }) =>
    snapshot(false, months.get(input.id)!),
  );
  const view = mount();
  try {
    await tick();
    nextMonth(view.host);
    await tick();
    nextMonth(view.host);
    await tick();
    january.resolve({ id: 'job-jan' });
    await tick();
    december.resolve({ id: 'job-dec' });
    await tick();
    expect(fixture.stop).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-dec' }));
    expect(
      fixture.poll.mock.calls.every(
        ([input]) => !input.day || input.day.startsWith(`${months.get(input.id)}-`),
      ),
    ).toBe(true);
    expect(fixture.poll.mock.lastCall?.[0]).toMatchObject({ id: 'job-jan', day: '2027-01-01' });
  } finally {
    view.close();
  }
});
