// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';

const state = vi.hoisted(() => ({
  account: null as { context: { uin: bigint; dbKey: string } } | null,
  open: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ account: state.account, setAccount: state.open }),
}));
beforeEach(() => {
  state.account = null;
  state.open.mockClear();
});

it('当前账号查询只返回已打开账号标识，不泄露密钥或触发开库', async () => {
  const caller = bootstrapRouter.createCaller({});
  expect(await caller.currentAccount()).toBeNull();
  state.account = { context: { uin: 10002n, dbKey: 'synthetic-private-key' } };
  expect(await caller.currentAccount()).toEqual({ uin: '10002' });
  expect(state.open).not.toHaveBeenCalled();
});

it('当前账号查询保留原授权检查', async () => {
  const caller = bootstrapRouter.createCaller({
    authorize: () => {
      throw Error('synthetic-unauthorized');
    },
  });
  await expect(caller.currentAccount()).rejects.toThrow('synthetic-unauthorized');
});
