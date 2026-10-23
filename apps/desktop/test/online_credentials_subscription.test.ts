import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
import { accountEventBus } from '../src/main/context/app_context';

const fixture = vi.hoisted(() => ({ services: {} as object | null }));
vi.mock('../src/main/context/app_context', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    getAppContext: () => ({ services: fixture.services }),
    accountEventBus: new EventEmitter(),
  };
});

beforeEach(() => {
  fixture.services = {};
  accountEventBus.removeAllListeners();
});

it('订阅建立及重连时主动重查，后续凭据就绪继续通知，取消后不泄漏监听', async () => {
  const next = vi.fn();
  const stream = await accountRouter.createCaller({}).onOnlineCredentialsReady();
  const subscription = stream.subscribe({ next });
  expect(next).toHaveBeenCalledOnce();
  accountEventBus.emit('onlineCredentialsReady', { at: 123 });
  expect(next).toHaveBeenLastCalledWith({ at: 123 });
  expect(next).toHaveBeenCalledTimes(2);
  subscription.unsubscribe();
  expect(accountEventBus.listenerCount('onlineCredentialsReady')).toBe(0);
  const reconnected = stream.subscribe({ next });
  expect(next).toHaveBeenCalledTimes(3);
  reconnected.unsubscribe();
});

it('账号关闭或同号换数据源后，旧订阅不接收新会话通知', async () => {
  const next = vi.fn();
  const stream = await accountRouter.createCaller({}).onOnlineCredentialsReady();
  const subscription = stream.subscribe({ next });
  next.mockClear();
  fixture.services = null;
  accountEventBus.emit('onlineCredentialsReady', { at: 123 });
  fixture.services = {};
  accountEventBus.emit('onlineCredentialsReady', { at: 456 });
  expect(next).not.toHaveBeenCalled();
  subscription.unsubscribe();
});
