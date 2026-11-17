import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CALENDAR_SOURCE_ORDER, calendarMonthDays } from '@weq/service/conversation-calendar';
import { CalendarTaskDetails } from '../src/renderer/src/components/CalendarTaskDetails';
import { CalendarNavigationContext } from '../src/renderer/src/lib/calendarNavigation';

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  locate: vi.fn(),
  control: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { calendarOverview: { task: { useQuery: fixture.query } } } },
  client: {
    account: {
      calendarOverview: {
        locate: { mutate: fixture.locate },
        control: { mutate: fixture.control },
      },
    },
  },
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 66,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 66 })),
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('任务详情复用按天数的单一进度、默认展开日志、日期与会话定位，不包含日历网格', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  const target = {
    kind: 'c2c' as const,
    conv: 'fixture',
    name: '测试会话',
    avatar: null,
    ancestors: [],
  };
  const anchor = { id: '1', seq: '1', time: 1 };
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
      day: input.day ?? '2026-11-08',
      snapshot: {
        enabledKinds: input.kinds,
        emptyReason: input.kinds.length ? undefined : '未选择统计内容',
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
        rows: input.kinds.length ? [{ target, anchor, count: 10 }] : [],
        totalRows: input.kinds.length ? 1 : 0,
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
  fixture.locate.mockResolvedValue({ target, anchor });
  fixture.control.mockResolvedValue(true);
  fixture.refetch.mockResolvedValue(undefined);
  const navigate = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(
          CalendarNavigationContext.Provider,
          { value: navigate },
          createElement(CalendarTaskDetails, {
            taskId: 'task',
            scope: { uin: 'fixture', configId: 'live' },
            running: true,
          }),
        ),
      ),
    );
    expect(host.querySelector('input[type="date"]')?.getAttribute('min')).toBe('2026-11-01');
    expect(host.querySelector('.weq-density-calendar-grid')).toBeNull();
    expect(host.querySelectorAll('[aria-label="统计内容"] button')).toHaveLength(8);
    const allKinds = host.querySelector<HTMLButtonElement>('[aria-label="全部统计内容"]')!;
    await act(async () => allKinds.click());
    expect(fixture.query.mock.lastCall?.[0].kinds).toEqual([]);
    expect(host.textContent).toContain('未选择统计内容');
    expect(host.textContent).not.toContain('当天没有消息');
    const c2c = host.querySelector<HTMLButtonElement>('[data-weq-select-id="c2c"]')!;
    await act(async () => c2c.click());
    expect(fixture.query.mock.lastCall?.[0].kinds).toEqual(['c2c']);
    act(() => c2c.focus());
    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => c2c.dispatchEvent(escapeEvent));
    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(c2c.getAttribute('aria-pressed')).toBe('true');
    expect(fixture.query.mock.lastCall?.[0].kinds).toEqual(['c2c']);
    await act(async () => allKinds.click());
    expect(fixture.query.mock.lastCall?.[0].kinds).toEqual(CALENDAR_SOURCE_ORDER);
    expect(host.querySelectorAll('progress')).toHaveLength(1);
    const pauseMonth = host.querySelector<HTMLButtonElement>('[aria-label="暂停当月统计"]')!;
    await act(async () => pauseMonth.click());
    expect(fixture.control).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'month', action: 'pause', id: 'job' }),
    );
    expect(fixture.refetch).toHaveBeenCalled();
    expect(host.querySelector('progress[aria-label="当月进度"]')?.getAttribute('value')).toBe('0');
    expect(host.querySelector('input[type="date"]')?.getAttribute('value')).toBe('2026-11-08');
    expect(host.querySelector('h4')?.textContent).toBe('统计进度');
    expect(
      host
        .querySelector('.weq-exp-detail-tasklog')!
        .compareDocumentPosition(host.querySelector('.weq-calendar-task-date')!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(host.textContent).toContain('等待可用读取连接，将自动继续');
    expect(host.textContent).toContain('漫游缓存');
    expect(host.textContent).toContain('测试会话');
    expect(fixture.query.mock.lastCall?.[0].includeLogs).toBe(true);
    const logs = host.querySelector<HTMLButtonElement>('.weq-exp-detail-tasklog-head')!;
    await act(async () => logs.click());
    expect(fixture.query.mock.lastCall?.[0].includeLogs).toBe(false);
    await act(async () => logs.click());
    expect(host.textContent).toContain('已计 10 条消息');
    const row = host.querySelector<HTMLButtonElement>('.weq-overview-calendar-row')!;
    await act(async () => row.click());
    expect(fixture.locate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job', target, anchor, expectedAccountConfigId: 'live' }),
    );
    expect(navigate).toHaveBeenCalledWith(target, anchor, undefined);
    await act(async () => logs.click());
    expect(fixture.query.mock.lastCall?.[0].includeLogs).toBe(false);
    expect(host.querySelector('.weq-exp-log')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
