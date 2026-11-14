import { afterEach, expect, it, vi } from 'vitest';
import { backgroundTasks } from '../src/main/background_tasks';
import { trackEnhancementPreparation } from '../src/main/enhancements/tasks';
import type { PackOperation } from '../src/main/enhancements/packs';

afterEach(() => vi.useRealTimers());
it('气泡、字体与挂件阶段只更新一个装扮离线索引任务，重复跟踪不产生并列任务', async () => {
  vi.useFakeTimers();
  let ready = false;
  let release = () => {};
  const operation: PackOperation = {
    phase: 'downloading',
    received: 0,
    total: 100,
    note: '准备气泡索引',
  };
  const complete = new Promise<void>((resolve) => {
    release = resolve;
  });
  const port = {
    list: async () => [{ id: 'dress' as const, ready, operation }],
    waitFor: async () => complete,
  };
  const before = backgroundTasks.snapshot().length;
  const task = trackEnhancementPreparation(port, 'dress', '装扮离线索引');
  expect(trackEnhancementPreparation(port, 'dress', '装扮离线索引')).toBe(task);
  for (const [received, note] of [
    [30, '准备气泡索引'],
    [70, '准备字体索引'],
    [90, '准备挂件索引'],
  ] as const) {
    Object.assign(operation, { received, note });
    await vi.advanceTimersByTimeAsync(750);
    expect(backgroundTasks.snapshot()).toHaveLength(before + 1);
    expect(backgroundTasks.snapshot().at(-1)).toMatchObject({
      kind: 'model',
      name: '装扮离线索引',
      status: 'running',
      progress: received,
      note: expect.stringContaining(note),
    });
  }
  ready = true;
  release();
  await task;
  expect(backgroundTasks.snapshot()).toHaveLength(before + 1);
  expect(backgroundTasks.snapshot().at(-1)).toMatchObject({ status: 'completed', progress: 100 });
});

it('补齐沿用同一任务的暂停、继续与失败重试操作', async () => {
  vi.useFakeTimers();
  let ready = false;
  let finish = () => {};
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const operation: PackOperation = { phase: 'downloading', received: 10, total: 100 };
  const port = {
    list: async () => [{ id: 'dress' as const, name: '补齐装扮', ready, operation }],
    waitFor: async () => complete,
    pause: vi.fn(() => {
      operation.paused = true;
      operation.pauseReasons = ['user'];
    }),
    resume: vi.fn(() => {
      operation.paused = false;
      operation.pauseReasons = [];
    }),
    start: vi.fn(),
  };
  const task = trackEnhancementPreparation(port, 'dress', '补齐装扮');
  await vi.advanceTimersByTimeAsync(750);
  const id = backgroundTasks.snapshot().at(-1)!.id;
  await backgroundTasks.act(id, 'pause');
  await vi.advanceTimersByTimeAsync(750);
  expect(backgroundTasks.snapshot().find((entry) => entry.id === id)).toMatchObject({
    status: 'paused',
    statusLabel: '已暂停',
    actions: [{ id: 'continue', label: '继续下载' }],
  });
  await backgroundTasks.act(id, 'continue');
  await vi.advanceTimersByTimeAsync(750);
  expect(port.resume).toHaveBeenCalledOnce();
  expect(backgroundTasks.snapshot().find((entry) => entry.id === id)?.status).toBe('running');
  Object.assign(operation, { phase: 'failed', error: 'offline' });
  finish();
  await expect(task).rejects.toThrow('offline');
  expect(backgroundTasks.snapshot().find((entry) => entry.id === id)).toMatchObject({
    status: 'failed',
    actions: [{ id: 'retry', label: '重试' }],
  });
  ready = true;
  operation.phase = 'ready';
  await backgroundTasks.act(id, 'retry');
  expect(port.start).toHaveBeenCalledWith(['dress']);
  await vi.advanceTimersByTimeAsync(0);
  expect(backgroundTasks.snapshot().at(-1)?.status).toBe('completed');
});
