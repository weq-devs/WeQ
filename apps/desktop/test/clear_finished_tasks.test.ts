// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { AccountServices } from '../src/main/context/app_context';
import { clearFinishedTasks } from '../src/main/ipc/routers/clear_finished_tasks';

describe('清除已结束任务', () => {
  it('重新核对状态、去重并保留进行中、暂停及保存中的任务，单项失败不阻断其他来源', async () => {
    const deleteTask = vi.fn((id: string) => id !== 'busy');
    const remove = vi.fn(() => {
      throw new Error('正在收尾');
    });
    const clearFinishedSelection = vi.fn(async () => 1);
    const tasks = [
      { id: 'done', status: 'completed' },
      { id: 'busy', status: 'completed' },
      { id: 'rerun', status: 'running' },
      { id: 'queued', status: 'pending' },
      { id: 'paused', status: 'paused' },
      { id: 'saving', status: 'completed', save: { status: 'saving' } },
      { id: 'save-failed', status: 'completed', save: { status: 'failed' } },
      { id: 'interrupted', status: 'completed', save: { status: 'interrupted' } },
      { id: 'failed', status: 'failed' },
      { id: 'cancelled', status: 'cancelled' },
    ];
    const services = {
      exportManager: { getTask: (id: string) => tasks.find((task) => task.id === id), deleteTask },
      roamingBackfill: {
        list: () => [
          { id: 'done', status: 'completed' },
          { id: 'partial', status: 'partial' },
          { id: 'failed', status: 'failed' },
          { id: 'cancelled', status: 'cancelled' },
          { id: 'pausing', status: 'pausing' },
        ],
        remove,
      },
      flashTransferFiles: { downloads: { clearFinishedSelection } },
    } as unknown as AccountServices;
    const result = await clearFinishedTasks(services, {
      exports: [
        'done',
        'done',
        'busy',
        'rerun',
        'queued',
        'paused',
        'saving',
        'save-failed',
        'interrupted',
        'failed',
        'cancelled',
        'missing',
      ],
      roaming: ['done', 'partial', 'failed', 'cancelled', 'pausing'],
      flash: ['flash-done', 'flash-running'],
    });
    expect(deleteTask.mock.calls).toEqual([
      ['done'],
      ['busy'],
      ['save-failed'],
      ['interrupted'],
      ['failed'],
      ['cancelled'],
    ]);
    // 三个已结束的漫游任务都尝试移除，但来源报错时只计入 errors 而不计入 removed。
    expect(remove.mock.calls).toEqual([['done'], ['failed'], ['cancelled']]);
    expect(clearFinishedSelection).toHaveBeenCalledWith(['flash-done', 'flash-running']);
    expect(result).toEqual({
      removed: 6,
      skipped: 9,
      errors: ['正在收尾', '正在收尾', '正在收尾'],
    });
  });
});
