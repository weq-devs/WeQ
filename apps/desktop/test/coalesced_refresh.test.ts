// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createCoalescedRefresh } from '../src/renderer/src/lib/coalescedRefresh';

it('慢查询期间连续通知仍逐轮交付，峰值在途为一，通知仅合并一轮', async () => {
  let release!: () => void;
  let inFlight = 0;
  let peak = 0;
  let delivered = 0;
  const load = vi.fn(async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    inFlight--;
    delivered++;
  });
  const refresh = createCoalescedRefresh(load);
  const task = refresh();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  for (let i = 0; i < 100; i++) expect(refresh()).toBe(task);
  release();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(delivered).toBe(1);
  release();
  await task;
  expect(delivered).toBe(2);
  expect(peak).toBe(1);
});

it('失败后允许后续请求重新读取', async () => {
  const load = vi.fn(async () => {}).mockRejectedValueOnce(new Error('锁库'));
  const refresh = createCoalescedRefresh(load);
  await expect(refresh()).rejects.toThrow('锁库');
  await refresh();
  expect(load).toHaveBeenCalledTimes(2);
});
