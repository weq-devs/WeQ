import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { conversationCalendarRouter } from '../src/main/ipc/routers/conversation_calendar';
import { backgroundTasks } from '../src/main/background_tasks';

const fixture = vi.hoisted(() => ({
  session: { context: { uin: 'fixture' } },
  closing: undefined as ((session: unknown) => void) | undefined,
  read: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: fixture.session,
    services: { accountConfig: { getRecord: () => ({ configId: 'live' }) } },
    platform: { native: { ntHelper: { executeSqlBudgeted: () => [] } } },
  }),
  accountEventBus: {
    on: (_name: string, handler: (session: unknown) => void) => {
      fixture.closing = handler;
    },
  },
}));
vi.mock('@weq/service/conversation-calendar-sources', () => ({
  createCalendarSources: () => [{ kind: 'c2c', count: async () => 0, page: () => fixture.read() }],
  generatedMessages: () => [],
}));
const binding = { expectedAccountUin: 'fixture', expectedAccountConfigId: 'live' };
beforeEach(() => {
  vi.useFakeTimers();
  fixture.read.mockReset();
});
afterEach(() => {
  fixture.closing?.(fixture.session);
  for (const task of backgroundTasks.snapshot()) {
    backgroundTasks.finish(task.id, 'cancelled');
    backgroundTasks.remove(task.id);
  }
  vi.useRealTimers();
});

it('同月同范围重开复用原统计和后台任务；切换来源选择不创建新任务', async () => {
  fixture.read.mockResolvedValue({ rows: [], done: true });
  const caller = conversationCalendarRouter.createCaller({});
  const input = { ...binding, month: '2027-01', day: '2027-01-10', targets: [] };
  const first = await caller.start(input);
  const task = await caller.background({ ...binding, id: first.id });
  const second = await caller.start({ ...input, day: '2027-01-01', kinds: [] });
  expect(second).toMatchObject({ id: first.id, day: input.day, background: true });
  expect(await caller.background({ ...binding, id: second.id })).toEqual(task);
  expect(backgroundTasks.snapshot()).toHaveLength(1);
  const detail = await caller.task({ ...binding, taskId: task.taskId, includeLogs: true });
  expect(detail).toMatchObject({
    id: first.id,
    month: input.month,
    day: input.day,
    snapshot: { enabledKinds: [], totalRows: 0 },
  });
  expect(detail.snapshot.logs?.length).toBeGreaterThan(0);
});

it('普通关闭再打开仍复用原句柄；账号与月份不混用', async () => {
  fixture.read.mockResolvedValue({ rows: [], done: true });
  const caller = conversationCalendarRouter.createCaller({});
  const input = { ...binding, month: '2027-02', day: '2027-02-10', targets: [] };
  const first = await caller.start(input);
  await caller.stop({ ...binding, id: first.id });
  await vi.runAllTimersAsync();
  const reopened = await caller.start(input);
  expect(reopened.id).toBe(first.id);
  expect((await caller.poll({ ...binding, id: first.id, day: input.day })).cancelled).toBe(false);
  expect((await caller.start({ ...input, month: '2027-03', day: '2027-03-10' })).id).not.toBe(
    first.id,
  );
  await expect(
    caller.task({ ...binding, expectedAccountConfigId: 'other', taskId: crypto.randomUUID() }),
  ).rejects.toThrow('切换');
});

it('打开日历不注册任务，明确后台进行才注册一次；无需续租，切账号立即取消', async () => {
  let release!: (value: { rows: never[]; done: boolean }) => void;
  fixture.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const caller = conversationCalendarRouter.createCaller({});
  const { id } = await caller.start({
    ...binding,
    month: '2026-11',
    day: '2026-11-10',
    targets: [],
  });
  expect(backgroundTasks.snapshot()).toHaveLength(0);
  const first = await caller.background({ ...binding, id });
  expect(await caller.background({ ...binding, id })).toEqual(first);
  expect(backgroundTasks.snapshot()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(6000);
  expect(backgroundTasks.snapshot()[0]?.status).toBe('running');
  fixture.closing?.(fixture.session);
  expect(backgroundTasks.snapshot()[0]?.status).toBe('cancelled');
  release({ rows: [], done: true });
  await vi.runAllTimersAsync();
  expect(fixture.read).toHaveBeenCalledTimes(1);
  await expect(caller.background({ ...binding, id })).rejects.toThrow('已停止');
  expect(backgroundTasks.snapshot()).toHaveLength(1);
});

it('直接关闭仍取消读取，不生成任务记录', async () => {
  let release!: (value: { rows: never[]; done: boolean }) => void;
  fixture.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const caller = conversationCalendarRouter.createCaller({});
  const { id } = await caller.start({
    ...binding,
    month: '2026-11',
    day: '2026-11-10',
    targets: [],
  });
  await caller.stop({ ...binding, id });
  release({ rows: [], done: true });
  await vi.runAllTimersAsync();
  expect(backgroundTasks.snapshot()).toHaveLength(0);
  expect(fixture.read).toHaveBeenCalledTimes(1);
});
