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
