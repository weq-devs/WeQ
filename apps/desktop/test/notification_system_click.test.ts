// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { NOTIFICATION_CLICK_LIMIT } from '../src/shared/notification_click';
import {
  consumeNotificationClick,
  notificationClickEvents,
  pushNotificationClick,
} from '../src/main/notification_click_bus';
import {
  activateNotificationClick,
  forgetNotificationClick,
  registerNotificationClick,
} from '../src/renderer/src/lib/notificationSystemClick';

afterEach(() => {
  notificationClickEvents.removeAllListeners();
  while (consumeNotificationClick()) {
    /* 清理本测试队列。 */
  }
});

it('系统点击先入队，重复信号不重复导航，主界面晚订阅也能接续', async () => {
  const first = registerNotificationClick(vi.fn());
  const action = vi.fn();
  const second = registerNotificationClick(action);
  pushNotificationClick(first);
  pushNotificationClick(first);
  pushNotificationClick(second);
  expect(consumeNotificationClick()).toBe(first);
  expect(await activateNotificationClick(consumeNotificationClick()!)).toBe(true);
  expect(action).toHaveBeenCalledOnce();
  expect(consumeNotificationClick()).toBeNull();
  forgetNotificationClick(first);
  forgetNotificationClick(second);
});

it('点击回调与待处理队列均有界；过期来源不跳到其他通知', async () => {
  const oldest = registerNotificationClick(() => {
    throw Error('不应执行旧目标');
  });
  const overflow = 5;
  const ids = Array.from({ length: NOTIFICATION_CLICK_LIMIT + overflow }, (_, index) => {
    const id = registerNotificationClick(vi.fn());
    pushNotificationClick(id);
    return { id, index };
  });
  expect(await activateNotificationClick(oldest)).toBe(false);
  expect(consumeNotificationClick()).toBe(ids[overflow]!.id);
  expect(await activateNotificationClick(ids.at(-1)!.id)).toBe(true);
  for (const { id } of ids) forgetNotificationClick(id);
});

it('派发信号前已经可读取真实点击，不需要轮询等待', () => {
  const receive = vi.fn(() => consumeNotificationClick());
  notificationClickEvents.on('click', receive);
  pushNotificationClick('fixture-click');
  expect(receive.mock.results[0]?.value).toBe('fixture-click');
});
