// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
import { dbEventBus, getAppContext } from '../src/main/context/app_context';

const f = vi.hoisted(() => ({ switched: false }));
vi.mock('../src/main/ocr/local', () => ({
  resolveLocalOcrModel: () => null,
  resolveLocalOcrFilterModel: () => null,
}));
vi.mock('../src/main/context/app_context', () => {
  const services = { accountConfig: { getRecord: () => ({ configId: 'source-a' }) } };
  const account = { context: { uin: '10001' } };
  return {
    dbEventBus: new EventEmitter(),
    accountEventBus: new EventEmitter(),
    getAppContext: () => ({ account, services: f.switched ? {} : services }),
  };
});
beforeEach(() => {
  f.switched = false;
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };

it('接入校准两类通知，变更只投递当前会话，换号与取消订阅后不再投递', async () => {
  const received: Array<{ kind: 'friend' | 'group' }> = [];
  const before = dbEventBus.listenerCount('contact-notices-changed');
  const stream = await accountRouter.createCaller({}).onContactNoticesChanged(binding);
  const sub = stream.subscribe({ next: (change) => received.push(change) });
  const session = getAppContext().account;
  try {
    expect(received).toEqual([{ kind: 'friend' }, { kind: 'group' }]);
    dbEventBus.emit('contact-notices-changed', { session: {}, kind: 'friend' });
    expect(received).toHaveLength(2);
    dbEventBus.emit('contact-notices-changed', { session, kind: 'group' });
    expect(received).toHaveLength(3);
    f.switched = true;
    dbEventBus.emit('contact-notices-changed', { session, kind: 'friend' });
    expect(received).toHaveLength(3);
  } finally {
    sub.unsubscribe();
  }
  expect(dbEventBus.listenerCount('contact-notices-changed')).toBe(before);
});

it('拒绝其他账号及同 QQ 号的其他数据源订阅', async () => {
  const api = accountRouter.createCaller({});
  await expect(
    api.onContactNoticesChanged({ ...binding, expectedAccountUin: '20002' }),
  ).rejects.toThrow();
  await expect(
    api.onContactNoticesChanged({ ...binding, expectedAccountConfigId: 'source-b' }),
  ).rejects.toThrow();
});
