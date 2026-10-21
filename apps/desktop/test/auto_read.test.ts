// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { readWithRetry } from '../src/renderer/src/lib/autoRead';

afterEach(() => vi.useRealTimers());

it('读取按退避最多尝试三次，成功后停止', async () => {
  vi.useFakeTimers();
  const work = vi
    .fn()
    .mockRejectedValueOnce(new Error('暂不可用'))
    .mockRejectedValueOnce(new Error('暂不可用'))
    .mockResolvedValue('结果');
  const result = readWithRetry(work, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(999);
  expect(work).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(work).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toBe('结果');
  expect(work).toHaveBeenCalledTimes(3);
});

it('耗尽重试时返回原错误，不无限循环', async () => {
  vi.useFakeTimers();
  const error = new Error('读取失败');
  const work = vi.fn().mockRejectedValue(error);
  const result = expect(readWithRetry(work, new AbortController().signal)).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
  expect(work).toHaveBeenCalledTimes(3);
});

it('隐藏或切源时取消退避等待，不再发起后续读取', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const work = vi.fn().mockRejectedValue(new Error('暂不可用'));
  const result = expect(readWithRetry(work, controller.signal)).rejects.toBe('已切换页面');
  await vi.advanceTimersByTimeAsync(500);
  controller.abort('已切换页面');
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
  expect(work).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('取消期间迟到的成功结果不会返回给旧页面', async () => {
  const controller = new AbortController();
  let finish!: (value: string) => void;
  const work = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const result = expect(readWithRetry(work, controller.signal)).rejects.toBe('旧来源');
  controller.abort('旧来源');
  finish('迟到结果');
  await result;
  expect(work).toHaveBeenCalledTimes(1);
});
