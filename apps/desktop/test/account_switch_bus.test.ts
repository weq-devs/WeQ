// @vitest-environment node
/**
 * 外部 MCP 切号请求的队列与「有没有界面能接」的判定。
 *
 * 这里盯两件事：请求按 FIFO 领走且不会无限堆积（切号过渡期间没人领是常态），
 * 以及订阅者计数如实反映界面在不在 —— MCP 工具靠它决定「投递」还是「当场报错」，
 * 数错了就会变成「调用成功但什么也没发生」。
 */

import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/main/context/app_context', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return { getAppContext: () => ({}), accountEventBus: new Emitter() };
});

import { accountEventBus } from '../src/main/context/app_context';
import {
  accountSwitchSubscriberClosed,
  accountSwitchSubscriberOpened,
  hasAccountSwitchSubscriber,
  pushAccountSwitchRequest,
  resetAccountSwitchBus,
  takeAccountSwitchRequest,
} from '../src/main/account_switch_bus';

beforeEach(() => {
  resetAccountSwitchBus();
  accountEventBus.removeAllListeners();
});

it('投递后按 FIFO 领走，领空返回 null', () => {
  pushAccountSwitchRequest({ configId: 'a', uin: '1', source: 'mcp', at: 1 });
  pushAccountSwitchRequest({ configId: 'b', uin: '2', source: 'mcp', at: 2 });
  expect(takeAccountSwitchRequest()).toMatchObject({ configId: 'a' });
  expect(takeAccountSwitchRequest()).toMatchObject({ configId: 'b' });
  expect(takeAccountSwitchRequest()).toBeNull();
});

it('投递会唤醒订阅者', () => {
  const handler = vi.fn();
  accountEventBus.on('accountSwitchRequested', handler);
  pushAccountSwitchRequest({ configId: 'a', uin: '1', source: 'mcp', at: 1 });
  expect(handler).toHaveBeenCalledOnce();
});

it('无人消费时队列有上界，丢掉最旧的目标', () => {
  for (let i = 0; i < 20; i += 1) {
    pushAccountSwitchRequest({ configId: `c${i}`, uin: String(i), source: 'mcp', at: i });
  }
  // 只保留最后 8 条：切号是「最终状态」语义，过时的目标没有意义。
  expect(takeAccountSwitchRequest()).toMatchObject({ configId: 'c12' });
  let count = 1;
  while (takeAccountSwitchRequest()) count += 1;
  expect(count).toBe(8);
});

it('订阅者计数反映界面在不在，且不会减成负数', () => {
  expect(hasAccountSwitchSubscriber()).toBe(false);
  accountSwitchSubscriberOpened();
  expect(hasAccountSwitchSubscriber()).toBe(true);
  accountSwitchSubscriberOpened();
  accountSwitchSubscriberClosed();
  expect(hasAccountSwitchSubscriber()).toBe(true);
  accountSwitchSubscriberClosed();
  expect(hasAccountSwitchSubscriber()).toBe(false);
  // 重复关闭（订阅被异常清理两次）不该把计数压到负数。
  accountSwitchSubscriberClosed();
  expect(hasAccountSwitchSubscriber()).toBe(false);
});
