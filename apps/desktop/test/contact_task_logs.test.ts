import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BackgroundTaskEntry } from '../src/renderer/src/hooks/useBackgroundTasks';
import type { BackgroundTaskScope } from '../src/shared/background_task';
import type { TaskLogLine } from '../src/renderer/src/components/TaskLogConsole';
import { BackgroundTaskDetails } from '../src/renderer/src/components/tasks/BackgroundTaskDetails';

const fixture = vi.hoisted(() => ({
  details: vi.fn(async () => ['重复的过程说明']),
  logs: vi.fn(async (): Promise<TaskLogLine[]> => []),
}));
vi.mock('../src/renderer/src/trpc/client', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  function query(path: 'details' | 'logs') {
    return {
      useQuery: (input: unknown, options: object) =>
        useQuery({
          queryKey: [path, input],
          queryFn: () => fixture[path](),
          retry: false,
          ...options,
        }),
    };
  }
  return {
    trpc: { backgroundTasks: { details: query('details'), logs: query('logs') } },
    client: {},
  };
});
vi.mock('../src/renderer/src/components/Dialog', () => ({ useDialog: () => vi.fn() }));
vi.mock('../src/renderer/src/components/CalendarTaskDetails', () => ({
  CalendarTaskDetails: () => null,
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.logs.mockReset().mockResolvedValue(logs(8));
  fixture.details.mockClear();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function logs(count: number): TaskLogLine[] {
  return Array.from({ length: count }, (_, index) => ({
    ts: 1700000000000 + index,
    seq: index + 1,
    stage: 'groups',
    level: 'info',
    text: `合成群名单日志 ${index + 1}`,
  }));
}
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const entry: BackgroundTaskEntry = {
    source: 'host',
    task: {
      id: 'synthetic-task',
      kind: 'contacts',
      name: '更新群成员名单',
      status: 'running',
      startedAt: 1,
      updatedAt: 1,
      actions: [],
      subtasks: [{ label: '群聊', done: 1, total: 10, failed: 0 }],
    },
  };
  const render = async (
    updatedAt = 1,
    id = entry.task.id,
    scope: BackgroundTaskScope | null = null,
  ) => {
    await act(async () => {
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(BackgroundTaskDetails, {
            entry: { ...entry, task: { ...entry.task, id, updatedAt } },
            scope,
            refresh: async () => {},
          }),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  cleanups.push(() => {
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
  });
  return { host, render };
}
it('群成员任务仅显示一个可滚动日志框，历史记录在同一框中查看', async () => {
  const { host, render } = mount();
  await render();
  expect(host.querySelector('.weq-contact-task-log')).toBeNull();
  expect(host.querySelectorAll('.weq-exp-detail-stage .weq-exp-log')).toHaveLength(1);
  expect(host.querySelectorAll('.weq-exp-detail-stage .weq-exp-log-line')).toHaveLength(8);
  expect(host.querySelector('.weq-exp-detail-stage .weq-exp-log')?.getAttribute('role')).toBe(
    'log',
  );
  expect(host.querySelector('details')).toBeNull();
  expect(host.querySelectorAll('.weq-exp-detail-stage')).toHaveLength(1);
  expect(host.textContent).not.toContain('获取结果');
  expect(host.textContent).not.toContain('重复的过程说明');
});
it('更新版本等待响应时不清空或重挂日志，完成后追加记录', async () => {
  const { host, render } = mount();
  await render();
  const terminal = host.querySelector('.weq-exp-detail-stage .weq-exp-log');
  const firstLine = terminal?.firstElementChild;
  let resolve!: (value: TaskLogLine[]) => void;
  fixture.logs.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render(2);
  expect(host.textContent).toContain('合成群名单日志 8');
  expect(host.textContent).not.toContain('暂无日志');
  expect(host.querySelector('.weq-exp-detail-stage .weq-exp-log')).toBe(terminal);
  await act(async () => {
    resolve(logs(9));
    await new Promise((done) => setTimeout(done, 10));
  });
  expect(host.textContent).toContain('合成群名单日志 9');
  expect(terminal?.firstElementChild).toBe(firstLine);
});
it.each(['task', 'account', 'config'])('切换 %s 时不沿用上一任务或账号的日志', async (change) => {
  const { host, render } = mount();
  await render(1, 'first-task', { uin: '10001', configId: 'first-config' });
  fixture.logs.mockReturnValueOnce(new Promise(() => {}));
  await render(2, change === 'task' ? 'second-task' : 'first-task', {
    uin: change === 'account' ? '10002' : '10001',
    configId: change === 'config' ? 'second-config' : 'first-config',
  });
  expect(host.textContent).not.toContain('合成群名单日志 8');
});

it('向上滚动查看历史时不被新日志拉回底部，回到底部后继续跟随', async () => {
  const { host, render } = mount();
  await render();
  const terminal = host.querySelector<HTMLDivElement>('.weq-exp-detail-stage .weq-exp-log')!;
  Object.defineProperties(terminal, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 240 },
  });
  fixture.logs.mockResolvedValue(logs(9));
  await render(2);
  expect(terminal.scrollTop).toBe(1000);
  terminal.scrollTop = 100;
  act(() => terminal.dispatchEvent(new Event('scroll')));
  fixture.logs.mockResolvedValue(logs(10));
  await render(3);
  expect(terminal.scrollTop).toBe(100);
  terminal.scrollTop = 760;
  act(() => terminal.dispatchEvent(new Event('scroll')));
  fixture.logs.mockResolvedValue(logs(11));
  await render(4);
  expect(terminal.scrollTop).toBe(1000);
});

it('日志刷新失败仍保留已有内容并明确提示错误', async () => {
  const { host, render } = mount();
  await render();
  fixture.logs.mockRejectedValueOnce(new Error('合成读取失败'));
  await render(2);
  expect(host.textContent).toContain('合成群名单日志 8');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成读取失败');
});
