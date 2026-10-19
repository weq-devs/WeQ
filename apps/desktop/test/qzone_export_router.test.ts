import { afterEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
const fixture = vi.hoisted(() => ({
  uin: '10001',
  configId: 'fixture-source',
  start: vi.fn(async (_input: unknown) => 'task'),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: fixture.uin } },
    services: {
      accountConfig: {
        getRecord: () => ({ configId: fixture.configId, qqOnline: true, qqPid: 1 }),
      },
      exportManager: { startTask: fixture.start },
    },
  }),
}));
afterEach(() => {
  fixture.uin = '10001';
  fixture.configId = 'fixture-source';
  vi.clearAllMocks();
});
const input = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'fixture-source',
  targetUin: '10002',
  name: '合成空间',
  format: 'json' as const,
  downloadMedia: false,
};
it('空间路由复制精确 tid，不叠加旧日期，空集合不扩成整空间', async () => {
  const api = accountRouter.createCaller({});
  for (const tids of [['a', 'c', 'a'], []]) {
    await api.startQzoneExport({ ...input, tids, range: { start: 10, end: 20 } });
    expect(fixture.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        qzone: true,
        qzoneTids: [...new Set(tids)],
        total: new Set(tids).size,
      }),
    );
    expect(fixture.start.mock.calls.at(-1)?.[0]).not.toHaveProperty('range');
  }
});
it('同号不同数据源及切号拒绝启动任务', async () => {
  fixture.configId = 'another-source';
  await expect(accountRouter.createCaller({}).startQzoneExport(input)).rejects.toThrow(
    '账号数据源已切换',
  );
  fixture.uin = '10003';
  await expect(accountRouter.createCaller({}).startQzoneExport(input)).rejects.toThrow(
    '账号已切换',
  );
  expect(fixture.start).not.toHaveBeenCalled();
});
