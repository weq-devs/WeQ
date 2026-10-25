// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
import { fullModeAllowed, clearFullMode } from '../src/main/context/full_mode';
const f = vi.hoisted(() => {
  const host = {
    account: { context: { uin: '10001' } },
    bootstrap: { userConfig: { getSettings: () => ({ autoAttachQq: false }) } },
    services: {
      accountConfig: { getRecord: () => ({ uin: '10001', configId: 'synthetic-live' }) },
    },
  };
  return { host };
});
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => f.host }));
beforeEach(() => {
  clearFullMode(f.host);
});
const input = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-live' };
it('真实路由只记录当前宿主运行请求，不写持久偏好且不宣称凭据就绪', async () => {
  expect(fullModeAllowed(f.host)).toBe(false);
  expect(await accountRouter.createCaller({}).requestFullMode(input)).toEqual({ requested: true });
  expect(fullModeAllowed(f.host)).toBe(true);
  expect(f.host.bootstrap.userConfig.getSettings().autoAttachQq).toBe(false);
});
it.each([
  { ...input, expectedAccountUin: '10002' },
  { ...input, expectedAccountConfigId: 'synthetic-backup' },
])('旧账号或同号旧来源不能授权当前来源', async (stale) => {
  await expect(accountRouter.createCaller({}).requestFullMode(stale)).rejects.toThrow('已切换');
  expect(fullModeAllowed(f.host)).toBe(false);
});
it('拒绝来源缺失或未经授权的请求', async () => {
  await expect(accountRouter.createCaller({}).requestFullMode(JSON.parse('{}'))).rejects.toThrow();
  await expect(
    accountRouter
      .createCaller({
        authorize: () => {
          throw new Error('合成拒绝');
        },
      })
      .requestFullMode(input),
  ).rejects.toThrow('合成拒绝');
  expect(fullModeAllowed(f.host)).toBe(false);
});
