// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createDbChangeNotification } from '../src/main/db_change_notification';

afterEach(() => vi.useRealTimers());

it('持续写库不饿死已读与消息刷新，每个窗口投递最新变化', async () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const notifier = createDbChangeNotification(emit);
  notifier.request(1);
  await vi.advanceTimersByTimeAsync(100);
  notifier.request(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith(2);
  notifier.request(3);
  await vi.advanceTimersByTimeAsync(200);
  expect(emit).toHaveBeenLastCalledWith(3);
  notifier.request(4);
  notifier.dispose();
  notifier.request(5);
  await vi.advanceTimersByTimeAsync(1000);
  expect(emit).toHaveBeenCalledTimes(2);
});
