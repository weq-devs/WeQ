// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { AccountServices } from '../src/main/context/app_context';
import { clearCompletedTasks } from '../src/main/ipc/routers/clear_completed_tasks';

describe('清除已完成任务', () => {
  it('重新核对状态、去重并保留保存中或失败任务，单项失败不阻断其他来源', async () => {
    const deleteTask = vi.fn((id: string) => id !== 'busy');
    const remove = vi.fn(() => {
      throw new Error('正在收尾');
    });
    const clearCompleted = vi.fn(async () => 1);
    const tasks = [
      { id: 'done', status: 'completed' },
      { id: 'busy', status: 'completed' },
      { id: 'rerun', status: 'running' },
      { id: 'saving', status: 'completed', save: { status: 'saving' } },
      { id: 'save-failed', status: 'completed', save: { status: 'failed' } },
    ];
    const services = {
      exportManager: { getTask: (id: string) => tasks.find((task) => task.id === id), deleteTask },
      roamingBackfill: {
        list: () => [
          { id: 'done', status: 'completed' },
          { id: 'partial', status: 'partial' },
        ],
        remove,
      },
      flashTransferFiles: { downloads: { clearCompleted } },
    } as unknown as AccountServices;
    const result = await clearCompletedTasks(services, {
      exports: ['done', 'done', 'busy', 'rerun', 'saving', 'save-failed', 'missing'],
      roaming: ['done', 'partial'],
      flash: ['flash-done', 'flash-running'],
    });
    expect(deleteTask.mock.calls).toEqual([['done'], ['busy']]);
    expect(remove.mock.calls).toEqual([['done']]);
    expect(clearCompleted).toHaveBeenCalledWith(['flash-done', 'flash-running']);
    expect(result).toEqual({ removed: 2, skipped: 7, errors: ['正在收尾'] });
  });
});
