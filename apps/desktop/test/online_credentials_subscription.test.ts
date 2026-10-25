// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
import { accountEventBus } from '../src/main/context/app_context';

const fixture = vi.hoisted(() => ({
  services: {} as object | null,
  hasSsoSession: vi.fn(async (_pid: number) => true),
}));
vi.mock('../src/main/context/app_context', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    getAppContext: () => ({
      bootstrap: {
        userConfig: { getSettings: () => ({ autoAttachQq: true }), getLocalModelId: () => null },
      },
      services: fixture.services,
      platform: { native: { ntHelper: { hasSsoSession: fixture.hasSsoSession } } },
      onlineCredentialsPending: () => false,
    }),
    accountEventBus: new EventEmitter(),
  };
});

beforeEach(() => {
  fixture.services = {};
  fixture.hasSsoSession.mockReset().mockResolvedValue(true);
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

it.each([
  { pid: 42, d2Key: 'cc'.repeat(16), needsMemoryRead: false },
  { pid: 41, d2Key: 'cc'.repeat(16), needsMemoryRead: true },
  { pid: 42, d2Key: 'zz'.repeat(16), needsMemoryRead: true },
  { pid: 42, d2Key: 'cc', needsMemoryRead: true },
  { pid: 42, d2Key: undefined, needsMemoryRead: true },
])('能力查询核对当前进程与凭据有效性：%j', async ({ pid, d2Key, needsMemoryRead }) => {
  fixture.services = {
    accountConfig: {
      getRecord: () => ({
        qqOnline: true,
        qqPid: 42,
        uid: '',
        guid: 'ab'.repeat(16),
        session: { pid, a2: 'aa', d2: 'bb', d2Key },
      }),
    },
  };
  const state = await accountRouter.createCaller({}).getGroupAlbumAccessState();
  expect(state.needsMemoryRead).toBe(needsMemoryRead);
  expect(state.hasUid).toBe(false);
  expect(state.ssoReady).toBe(false);
  expect(fixture.hasSsoSession).not.toHaveBeenCalled();
});

function completeCredentials() {
  fixture.services = {
    accountConfig: {
      getRecord: () => ({
        qqOnline: true,
        qqPid: 42,
        uid: 'u_fixture',
        guid: 'ab'.repeat(16),
        session: { pid: 42, a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16) },
      }),
    },
  };
}

it.each([false, true])('凭据写盘后仍核对实际原生登记状态：%j', async (registered) => {
  completeCredentials();
  fixture.hasSsoSession.mockResolvedValue(registered);
  const state = await accountRouter.createCaller({}).getGroupAlbumAccessState();
  expect(state.needsMemoryRead).toBe(false);
  expect(state.hasUid).toBe(true);
  expect(state.ssoReady).toBe(registered);
  expect(state.credentialsPending).toBe(false);
  expect(fixture.hasSsoSession).toHaveBeenCalledWith(42);
});

it('查询原生登记期间切换账号，不返回旧账号的完整模式状态', async () => {
  completeCredentials();
  fixture.hasSsoSession.mockImplementationOnce(async () => {
    fixture.services = {};
    return true;
  });
  await expect(accountRouter.createCaller({}).getGroupAlbumAccessState()).rejects.toThrow('账号');
});
