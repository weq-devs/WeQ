import { afterEach, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { backgroundTasks } from '../src/main/background_tasks';
import { backgroundTasksRouter } from '../src/main/ipc/routers/background_tasks';
import { TaskLogConsole } from '../src/renderer/src/components/TaskLogConsole';

afterEach(() => {
  for (const task of backgroundTasks.snapshot()) {
    backgroundTasks.finish(task.id, 'cancelled');
    backgroundTasks.remove(task.id);
  }
});

it('日历日志按需读取且按账号数据源隔离，普通任务列表不携带日志正文', async () => {
  const scope = { uin: 'synthetic', configId: 'live' };
  const logs = [
    { ts: 0, seq: 1, stage: 'task', level: 'info' as const, text: '已完成 3/8 个来源' },
  ];
  const id = backgroundTasks.start({ kind: 'calendar', name: '会话日历', scope, logs });
  const caller = backgroundTasksRouter.createCaller({});
  expect((await caller.list(scope))[0]).not.toHaveProperty('logs');
  expect(await caller.logs({ id, scope, updatedAt: 0 })).toEqual(logs);
  await expect(
    caller.logs({ id, scope: { ...scope, configId: 'backup' }, updatedAt: 0 }),
  ).rejects.toThrow('失效');
});

it('复用导出日志的最近五行与级别样式及北京时间，不显示完整日志入口', () => {
  const lines = Array.from({ length: 8 }, (_, seq) => ({
    ts: 0,
    seq,
    stage: 'group',
    level: 'warn' as const,
    text: `批次 ${seq}`,
  }));
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    createElement(TaskLogConsole, { lines, collapsed: false, history: true }),
  );
  expect(host.querySelectorAll('.weq-exp-log-line')).toHaveLength(5);
  expect(host.querySelector('.weq-task-log-history')).toBeNull();
  expect(host.querySelector('.weq-exp-log-time')?.textContent).toBe('08:00:00.000');
  expect(host.querySelector('.weq-exp-log-line')?.className).toContain('is-warn');
});
