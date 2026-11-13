// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UpdateCheckScheduler } from '../src/main/update/scheduler';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('启动延迟检查，随后按分钟周期执行，停用后没有新检查', async () => {
  const check = vi.fn(async () => {});
  const scheduler = new UpdateCheckScheduler(check);
  scheduler.configure(60, true);
  await vi.advanceTimersByTimeAsync(2999);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(check).toHaveBeenCalledTimes(2);
  scheduler.configure(-1);
  await vi.advanceTimersByTimeAsync(120 * 60_000);
  expect(check).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('永不关闭启动检查；改为正数立即重新计时，支持小数分钟', async () => {
  const check = vi.fn(async () => {});
  const scheduler = new UpdateCheckScheduler(check);
  scheduler.configure(-1, true);
  expect(vi.getTimerCount()).toBe(0);
  scheduler.configure(60);
  await vi.advanceTimersByTimeAsync(30_000);
  scheduler.configure(0.5);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledOnce();
  scheduler.stop();
});

it('超过系统定时器上限的间隔不会提前触发', async () => {
  const check = vi.fn(async () => {});
  const scheduler = new UpdateCheckScheduler(check);
  const minutes = 100_000;
  scheduler.configure(minutes);
  await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledOnce();
  scheduler.configure(Number.MAX_VALUE);
  await vi.advanceTimersByTimeAsync(2 ** 31);
  expect(check).toHaveBeenCalledOnce();
  scheduler.stop();
});

it('检查不重叠，在途修改频率后按新值计时，失败后继续下个周期', async () => {
  let finish: (() => void) | undefined;
  const check = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const scheduler = new UpdateCheckScheduler(check);
  scheduler.configure(1);
  await vi.advanceTimersByTimeAsync(60_000);
  scheduler.configure(2);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(check).toHaveBeenCalledOnce();
  finish?.();
  await vi.advanceTimersByTimeAsync(119_999);
  expect(check).toHaveBeenCalledOnce();
  check.mockRejectedValueOnce(new Error('离线'));
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(check).toHaveBeenCalledTimes(3);
  scheduler.configure(-1);
  finish?.();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(vi.getTimerCount()).toBe(0);
});
