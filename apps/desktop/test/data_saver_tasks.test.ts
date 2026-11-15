// @vitest-environment node
import { expect, it } from 'vitest';
import { unfinishedDataSaverTasks } from '../src/shared/data_saver_tasks';
import { BackgroundTaskRegistry } from '../src/shared/background_task';

it('运行、排队、暂停和保存阶段均未结束，失败取消成功均结束', () => {
  expect(
    unfinishedDataSaverTasks({
      exports: [
        { status: 'pending' },
        { status: 'paused' },
        { status: 'running' },
        { status: 'completed', save: { status: 'saving', updatedAt: 1 } },
        { status: 'completed', isFinalizing: true },
        { status: 'failed' },
        { status: 'cancelled' },
      ],
      roaming: [{ status: 'paused' }, { status: 'pausing' }, { status: 'completed' }],
      scanning: true,
      flash: [
        { status: 'pending' },
        { status: 'resolving' },
        { status: 'downloading' },
        { status: 'failed' },
      ],
      background: [{ status: 'paused' }, { status: 'running' }, { status: 'cancelled' }],
    }),
  ).toBe(13);
  expect(unfinishedDataSaverTasks({})).toBe(0);
});
it('历史回执上限不淘汰仍未结束的暂停任务', () => {
  const tasks = new BackgroundTaskRegistry(1);
  const paused = tasks.start({ kind: 'resource', name: '暂停下载' });
  tasks.finish(paused, 'paused');
  for (let index = 0; index < 3; index++)
    tasks.finish(tasks.start({ kind: 'resource', name: '已结束下载' }), 'completed');
  expect(tasks.snapshot().some((task) => task.id === paused)).toBe(true);
  expect(unfinishedDataSaverTasks({ background: [...tasks.snapshot()] })).toBe(1);
});
