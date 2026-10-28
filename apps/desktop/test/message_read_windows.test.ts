// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { scheduleDatabase } from '@weq/db';
import { MessageReadWindows } from '../src/main/ipc/message_reads';

const window = (generation: number, owner = 'renderer-a') => ({ owner, generation });

it('新会话撤销旧窗口排队 SQL，不中断已执行的原生工作，且拒收迟到结果', async () => {
  const reads = new MessageReadWindows();
  const queued = vi.fn(async () => '旧页');
  let release!: () => void;
  const running = reads.run(window(1), () =>
    scheduleDatabase(
      '/synthetic/message-windows.db',
      () =>
        new Promise<string>((done) => {
          release = () => done('旧首屏');
        }),
    ),
  );
  const runningError = expect(running).rejects.toMatchObject({ name: 'AbortError' });
  const pending = reads.run(window(1), () =>
    scheduleDatabase('/synthetic/message-windows.db', queued),
  );
  const pendingError = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const next = reads.run(window(2), () =>
    scheduleDatabase('/synthetic/message-windows.db', async () => '新页'),
  );
  await pendingError;
  expect(queued).not.toHaveBeenCalled();
  release();
  expect(await next).toBe('新页');
  await runningError;
});

it('取消先于请求、旧取消迟到、双向定位和不同渲染窗口互不干扰', async () => {
  const reads = new MessageReadWindows();
  const read = vi.fn(async () => 1);
  reads.cancel(window(1));
  await expect(reads.run(window(1), read)).rejects.toMatchObject({ name: 'AbortError' });
  expect(read).not.toHaveBeenCalled();
  expect(await reads.run(window(2), read)).toBe(1);
  reads.cancel(window(1));
  expect(await Promise.all([reads.run(window(2), read), reads.run(window(2), read)])).toEqual([
    1, 1,
  ]);
  reads.cancel(window(2));
  expect(await reads.run(window(1, 'renderer-b'), read)).toBe(1);
  await expect(reads.run(window(1), read)).rejects.toMatchObject({ name: 'AbortError' });
});
it('提升先于订阅到达时也保留交互优先级，旧提升不会复活取消的窗口', async () => {
  const reads = new MessageReadWindows();
  const order: string[] = [];
  let release!: () => void;
  const running = scheduleDatabase(
    '/synthetic/promotion-before.db',
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  reads.promote(window(1));
  const background = reads.run(
    window(1, 'other'),
    () =>
      scheduleDatabase('/synthetic/promotion-before.db', async () => {
        order.push('background');
      }),
    'background',
  );
  const page = reads.run(
    window(1),
    () =>
      scheduleDatabase('/synthetic/promotion-before.db', async () => {
        order.push('page');
      }),
    'background',
  );
  release();
  await Promise.all([running, background, page]);
  expect(order).toEqual(['page', 'background']);
  reads.cancel(window(2));
  reads.promote(window(1));
  await expect(reads.run(window(2), async () => 1)).rejects.toMatchObject({ name: 'AbortError' });
});
