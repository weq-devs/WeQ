import { describe, expect, it, vi } from 'vitest';
import type { DressIndexKind, DressIndexState } from '@weq/service';

const events = vi.hoisted(() => ({
  listener: null as
    | null
    | ((event: {
        store: {
          directory: string;
          ensure: (kind: DressIndexKind, retry: boolean) => Promise<boolean>;
        };
        state: DressIndexState;
      }) => void),
}));
vi.mock('@weq/service', () => ({
  subscribeDressIndexResources: (listener: NonNullable<typeof events.listener>) => {
    events.listener = listener;
    return () => {};
  },
}));
import { backgroundTasks } from '../src/main/background_tasks';
import { installDressIndexTasks } from '../src/main/dress_index_tasks';

describe('装扮索引下载任务', () => {
  it('并发进度复用同一任务，失败可重试，成功后完成且不留重试按钮', async () => {
    installDressIndexTasks();
    installDressIndexTasks();
    const ensure = vi.fn(async () => true);
    const store = { directory: '/fixture/index', ensure };
    const emit = (status: DressIndexState['status'], downloadedBytes = 0) =>
      events.listener!({
        store,
        state: { kind: 'bubble', status, downloadedBytes, totalBytes: 100 },
      });
    emit('downloading');
    emit('downloading', 30);
    const task = backgroundTasks.snapshot().at(-1)!;
    expect(task).toMatchObject({ kind: 'resource', status: 'running', progress: 30 });
    emit('failed');
    const failed = backgroundTasks.snapshot().at(-1)!;
    expect(failed.id).toBe(task.id);
    expect(failed.status).toBe('failed');
    expect(failed.actions).toEqual([{ id: 'retry', label: '重试' }]);
    await backgroundTasks.act(task.id, 'retry');
    expect(ensure).toHaveBeenCalledWith('bubble', true);
    emit('downloading');
    emit('ready', 100);
    expect(backgroundTasks.snapshot().at(-1)).toMatchObject({
      status: 'completed',
      progress: 100,
      actions: [],
    });
  });
});
