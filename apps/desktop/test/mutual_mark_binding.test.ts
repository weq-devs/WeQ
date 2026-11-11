// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { mutualMarkRouter } from '../src/main/ipc/routers/mutual_mark';

const state = vi.hoisted(() => ({
  configId: 'config-a',
  uin: 99999n,
  query: vi.fn(),
  attach: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    webQuery: { getFriendMutualMark: (...args: unknown[]) => state.query(...args) },
    accountConfig: { getRecord: () => ({ configId: state.configId }) },
  };
  return {
    requireAttachEnabled: () => state.attach(),
    getAppContext: () => ({ services, account: { context: { uin: state.uin } } }),
  };
});

it('账号绑定不匹配不发请求，等待期间切换账号不返回旧结果', async () => {
  const caller = mutualMarkRouter.createCaller({});
  state.configId = 'config-a';
  state.uin = 99999n;
  state.query.mockReset();
  const binding = {
    uin: '10001',
    expectedAccountUin: '99999',
    expectedAccountConfigId: 'config-a',
  };
  await expect(caller.get({ ...binding, expectedAccountConfigId: 'config-b' })).rejects.toThrow(
    '账号已切换',
  );
  expect(state.query).not.toHaveBeenCalled();
  state.query.mockImplementationOnce(async () => {
    state.configId = 'config-b';
    return { categories: [] };
  });
  await expect(caller.get(binding)).rejects.toThrow('账号已切换');
  state.configId = 'config-a';
  state.query.mockResolvedValueOnce({ categories: [], totalNum: 0 });
  await expect(caller.get(binding)).resolves.toEqual({ categories: [], totalNum: 0 });
});
