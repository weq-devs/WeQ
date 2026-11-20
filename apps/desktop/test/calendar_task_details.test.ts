import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { calendarMonthDays } from '@weq/service/conversation-calendar';
import { CalendarTaskDetails } from '../src/renderer/src/components/CalendarTaskDetails';

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  control: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { calendarOverview: { task: { useQuery: fixture.query } } } },
  client: {
    account: {
      calendarOverview: {
        control: { mutate: fixture.control },
      },
    },
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('任务详情读取按天进度和日志，保留暂停操作', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const days = calendarMonthDays('2026-11').map(({ day }) => ({
    day,
    count: 10,
    complete: false,
    errors: [],
  }));
  fixture.query.mockImplementation((input) => ({
    data: {
      id: 'job',
      month: '2026-11',
      day: '2026-11-08',
      snapshot: {
        controls: {
          month: { state: 'running', disabled: false },
          day: { state: 'running', disabled: false },
        },
        days,
        progress: { completedSources: 2, totalSources: 60, failedSources: 0 },
        dayProgress: { completedSources: 1, totalSources: 2, count: 10 },
        readState: { state: 'queued', since: 0 },
        scanDayProgress: { day: '2026-11-09', completedSources: 0, totalSources: 2, count: 3 },
        activeScan: {
          day: '2026-11-09',
          kind: 'c2c',
          progress: { phase: '漫游缓存', processed: 4, unit: '个会话' },
        },
        complete: false,
        cancelled: false,
        logs: input.includeLogs
          ? [{ ts: 0, seq: 1, stage: 'task', level: 'info', text: '已计 10 条消息' }]
          : undefined,
      },
    },
    error: null,
    refetch: fixture.refetch,
  }));
  fixture.control.mockResolvedValue(true);
  fixture.refetch.mockResolvedValue(undefined);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(CalendarTaskDetails, {
          taskId: 'task',
          scope: { uin: 'fixture', configId: 'live' },
          running: true,
        }),
      ),
    );
    expect(fixture.query.mock.lastCall?.[0]).toEqual({
      taskId: 'task',
      expectedAccountUin: 'fixture',
      expectedAccountConfigId: 'live',
      limit: 0,
      includeLogs: true,
    });
    expect(host.querySelector('[aria-label="统计内容"]')).toBeNull();
    expect(host.querySelector('[aria-label="当天会话"]')).toBeNull();
    expect(host.querySelectorAll('progress')).toHaveLength(1);
    const pauseMonth = host.querySelector<HTMLButtonElement>('[aria-label="暂停当月统计"]')!;
    await act(async () => pauseMonth.click());
    expect(fixture.control).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'month', action: 'pause', id: 'job' }),
    );
    expect(fixture.refetch).toHaveBeenCalled();
    expect(host.querySelector('progress[aria-label="当月进度"]')?.getAttribute('value')).toBe('0');
    expect(host.textContent).toContain('等待可用读取连接，将自动继续');
    expect(host.textContent).toContain('漫游缓存');
    const logs = host.querySelector<HTMLButtonElement>('.weq-exp-detail-tasklog-head')!;
    await act(async () => logs.click());
    expect(fixture.query.mock.lastCall?.[0].includeLogs).toBe(false);
    await act(async () => logs.click());
    expect(host.textContent).toContain('已计 10 条消息');
    await act(async () => logs.click());
    expect(fixture.query.mock.lastCall?.[0].includeLogs).toBe(false);
    expect(host.querySelector('.weq-exp-log')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
