import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AnalysisReportSummary } from '../../../packages/service/src/account/analysis_reports';
import type { AccountServices } from '../src/main/context/app_context';
import { createAnalysisReportsRouter } from '../src/main/ipc/routers/analysis_reports';
import { backgroundTasksRouter } from '../src/main/ipc/routers/background_tasks';
import { backgroundTasks } from '../src/main/background_tasks';
import { TaskNotificationTracker } from '../src/renderer/src/lib/taskNotificationState';
import { summarizeWorkspaceTasks } from '../src/renderer/src/lib/workspaceIndicators';

const f = vi.hoisted(() => ({
  list: vi.fn<() => Promise<AnalysisReportSummary[]>>(),
  dispose: vi.fn(async () => undefined),
  account: {},
  emitter: null as EventEmitter | null,
}));
vi.mock('@weq/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weq/service')>()),
  AnalysisReportsService: class extends EventEmitter {
    constructor() {
      super();
      f.emitter = this;
    }
    list = f.list;
    dispose = f.dispose;
  },
}));
vi.mock('../src/main/context/app_context', () => ({
  accountEventBus: new EventEmitter(),
  getAppContext: () => ({
    account: f.account,
    platform: { appDataRoot: () => '/synthetic' },
  }),
}));
vi.mock('../src/main/worker_path', () => ({
  resolveChildWorkerPath: () => '/synthetic/analysisReportsWorker.mjs',
}));

const scope = { uin: '10001', configId: 'fixture' };
const report: AnalysisReportSummary = {
  request: {
    id: 'report',
    kind: 'buddy',
    name: '合成对象',
    peerUid: 'u_fixture',
    period: '全部',
    scope: { expectedAccountUin: scope.uin, expectedAccountConfigId: scope.configId },
  },
  status: 'completed',
  completed: ['report'],
  logs: [],
  revision: 1,
  resultRevision: 1,
  position: 0,
  updatedAt: 1,
};

beforeEach(() => {
  f.list.mockReset();
  f.dispose.mockClear();
  const services = {} as AccountServices;
  createAnalysisReportsRouter(() => services);
});
afterEach(async () => {
  const { accountEventBus } = await import('../src/main/context/app_context');
  accountEventBus.emit('closing', f.account);
  await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
  for (const task of backgroundTasks.snapshot()) {
    backgroundTasks.finish(task.id, 'cancelled');
    backgroundTasks.remove(task.id);
  }
  vi.restoreAllMocks();
});

it('首次及并发列表等待迟到的历史报告，建立静默基线后仍提醒本次重新分析完成', async () => {
  let restore!: (reports: AnalysisReportSummary[]) => void;
  f.list.mockReturnValueOnce(new Promise((resolve) => (restore = resolve)));
  const caller = backgroundTasksRouter.createCaller({});
  const returned = vi.fn();
  const first = caller.list(scope).then((tasks) => {
    returned();
    return tasks;
  });
  const concurrent = caller.list(scope);
  await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
  expect(returned).not.toHaveBeenCalled();
  expect(backgroundTasks.snapshot()).toEqual([]);
  restore([report]);
  const tasks = await first;
  expect(await concurrent).toEqual(tasks);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ status: 'completed', updatedAt: 1 });

  const tracker = new TaskNotificationTracker();
  const notices = () =>
    tracker.update(
      'fixture',
      summarizeWorkspaceTasks({ background: backgroundTasks.snapshot() }).items,
      true,
    );
  expect(notices()).toEqual([]);
  f.list.mockResolvedValue([{ ...report, status: 'running', updatedAt: 2 }]);
  f.emitter!.emit('changed', report.request.id);
  await vi.waitFor(() => expect(backgroundTasks.snapshot()[0]?.status).toBe('running'));
  expect(notices().map((notice) => notice.event)).toEqual(['progress']);
  f.list.mockResolvedValue([{ ...report, updatedAt: 3 }]);
  f.emitter!.emit('changed', report.request.id);
  await vi.waitFor(() => expect(backgroundTasks.snapshot()[0]?.status).toBe('completed'));
  expect(notices().map((notice) => notice.event)).toEqual(['taskComplete']);
  expect(notices()).toEqual([]);
});

it('恢复失败不返回虚假的空列表，后续查询可以重试恢复', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  f.list.mockRejectedValueOnce(new Error('合成读取失败'));
  const caller = backgroundTasksRouter.createCaller({});
  await expect(caller.list(scope)).rejects.toThrow('合成读取失败');
  f.list.mockResolvedValue([report]);
  expect(await caller.list(scope)).toHaveLength(1);
  expect(f.list).toHaveBeenCalledTimes(2);
});
