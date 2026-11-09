import {
  calendarMonthDays,
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
export const client = {
  account: {
    calendarOverview: {
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
export const trpc = {
  account: {
    calendarOverview: {
      task: {
        useQuery: (input: {
          day?: string;
          kinds: CalendarKind[];
          includeLogs: boolean;
          limit: number;
        }) => {
          const c2c = input.kinds.includes('c2c');
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
                enabledKinds: input.kinds,
                controls: {
                  month: {
                    state: input.kinds.length ? controls.month : 'empty',
                    disabled: !input.kinds.length,
                  },
                  day: {
                    state: input.kinds.length ? controls.day : 'empty',
                    disabled: !input.kinds.length,
                  },
                },
                hasPending:
                  input.kinds.length > 0 &&
                  (!completed || controls.month === 'running' || controls.day === 'running'),
                emptyReason: input.kinds.length ? undefined : '未选择统计内容',
                days: calendarMonthDays('2026-11').map(({ day }) => ({
                  day,
                  count: c2c ? 42 : 0,
                  complete: completed,
                  errors: [],
                })),
                progress: {
                  completedSources: completed
                    ? input.kinds.length * 30
                    : Math.min(2, input.kinds.length * 30),
                  totalSources: input.kinds.length * 30,
                  failedSources: 0,
                },
                dayProgress: {
                  completedSources: completed
                    ? input.kinds.length
                    : Math.min(1, input.kinds.length),
                  totalSources: input.kinds.length,
                  count: c2c ? 142 : 0,
                },
                readState:
                  completed && controls.month === 'complete' && controls.day === 'complete'
                    ? undefined
                    : { state: 'queued' as const, since: 0 },
                scanDayProgress: {
                  day: '2026-11-09',
                  completedSources: 0,
                  totalSources: input.kinds.length,
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
                        text: '2026-11-08 · 私聊 · 漫游缓存｜已计 142 条消息，等待前序数据库查询结束',
                      },
                    ]
                  : undefined,
              },
            },
            error: null,
            refetch: async () => undefined,
          };
        },
      },
    },
  },
};
