import {
  calendarMonthDays,
  CALENDAR_SOURCE_ORDER,
  type CalendarKind,
  type CalendarTarget,
  type CalendarControlState,
  type CalendarControlAction,
} from '@weq/service/conversation-calendar';

const target: CalendarTarget = {
  kind: 'c2c',
  conv: 'fixture',
  name: '用于验证长会话名称与窄屏换行的测试会话',
  avatar: null,
  ancestors: [],
};
const anchor = { id: '1', seq: '1', time: 1 };
const completed = new URLSearchParams(location.search).has('completed');
const controls: { month: CalendarControlState; day: CalendarControlState } = {
  month: completed ? 'complete' : 'running',
  day: completed ? 'complete' : 'running',
};
let polls = 0;
export const client = {
  account: {
    calendarOverview: {
      start: { mutate: async () => ({ id: 'fixture' }) },
      stop: { mutate: async () => true },
      background: { mutate: async () => ({ taskId: 'fixture' }) },
      poll: {
        query: async (input: Parameters<typeof calendarResult>[0]) => {
          const result = calendarResult(input).data.snapshot;
          document.documentElement.dataset.calendarPolls = String(++polls);
          result.activeScan.progress.processed = polls;
          if (result.logs?.[0]) result.logs[0].text = `已处理 ${polls} 个会话`;
          return result;
        },
      },
      locate: { mutate: async () => ({ target, anchor }) },
      control: {
        mutate: async ({
          scope,
          action,
        }: {
          scope: 'month' | 'day';
          action: CalendarControlAction;
        }) => {
          controls[scope] = action === 'pause' ? 'paused' : 'running';
        },
      },
    },
  },
};
function calendarResult(input: {
  day?: string;
  kinds?: CalendarKind[];
  includeLogs: boolean;
  limit: number;
}) {
  const kinds = input.kinds ?? CALENDAR_SOURCE_ORDER;
  const c2c = kinds.includes('c2c');
  const rows = c2c
    ? Array.from({ length: 80 }, (_, i) => ({
        target: { ...target, conv: String(i), name: `${target.name} ${i}` },
        anchor,
        count: 100 + i,
      }))
    : [];
  return {
    data: {
      id: 'fixture',
      month: '2026-11',
      day: input.day ?? '2026-11-08',
      snapshot: {
        enabledKinds: kinds,
        controls: {
          month: {
            state: kinds.length ? controls.month : 'empty',
            disabled: !kinds.length,
          },
          day: {
            state: kinds.length ? controls.day : 'empty',
            disabled: !kinds.length,
          },
        },
        hasPending:
          kinds.length > 0 &&
          (!completed || controls.month === 'running' || controls.day === 'running'),
        emptyReason: kinds.length ? undefined : '未选择统计内容',
        days: calendarMonthDays('2026-11').map(({ day }) => ({
          day,
          count: c2c ? 42 : 0,
          complete: completed,
          errors: [],
        })),
        progress: {
          completedSources: completed ? kinds.length * 30 : Math.min(2, kinds.length * 30),
          totalSources: kinds.length * 30,
          failedSources: 0,
        },
        dayProgress: {
          completedSources: completed ? kinds.length : Math.min(1, kinds.length),
          totalSources: kinds.length,
          count: c2c ? 142 : 0,
        },
        readState:
          completed && controls.month === 'complete' && controls.day === 'complete'
            ? undefined
            : { state: 'queued' as const, since: 0 },
        scanDayProgress: {
          day: '2026-11-09',
          completedSources: 0,
          totalSources: kinds.length,
          count: 3,
        },
        activeScan: {
          day: '2026-11-09',
          kind: 'c2c' as const,
          progress: { phase: '漫游缓存', processed: 4, total: 26, unit: '个会话' },
        },
        complete: completed,
        cancelled: false,
        rows: rows.slice(0, input.limit),
        totalRows: rows.length,
        logs: input.includeLogs
          ? [
              {
                ts: Date.parse('2026-11-08T12:00:00+08:00'),
                seq: 1,
                level: 'info' as const,
                stage: 'c2c',
                text: '2026-11-08 · 私聊 · 漫游缓存｜已计 142 条消息，等待可用读取连接，将自动继续',
              },
            ]
          : undefined,
      },
    },
    error: null,
    refetch: async () => undefined,
  };
}
export const trpc = {
  account: { calendarOverview: { task: { useQuery: calendarResult } } },
};
