import { expect, it, vi } from 'vitest';
import { createQQWriteRouter, type QQWriteServices } from '../src/main/ipc/routers/qq_write';

const binding = { expectedAccountUin: '10002', expectedAccountConfigId: 'fixture' };
function fixture() {
  const accountWrite = {
    selfProfileDisplaySettings: vi.fn(async () => ({ targetUin: '10002', settings: [] })),
    setSelfProfileDisplaySetting: vi.fn(async (_field: string, _value: number) => ({
      targetUin: '10002',
      field: 'gender',
      state: 'confirmed',
      setting: null,
      error: null,
    })),
  };
  const services = { accountWrite } as unknown as QQWriteServices;
  let current = services;
  const resolve = vi.fn(() => current);
  const caller = createQQWriteRouter(resolve, resolve).createCaller({});
  return {
    accountWrite,
    caller,
    switch: () => {
      current = { ...services };
    },
  };
}
it('仅账号绑定，没有客户端目标 UIN；单项参数准确传递', async () => {
  const f = fixture();
  await f.caller.selfProfileDisplaySettings(binding);
  await f.caller.setSelfProfileDisplaySetting({ ...binding, field: 'gender', value: 2 });
  expect(f.accountWrite.setSelfProfileDisplaySetting).toHaveBeenCalledWith('gender', 2);
  await expect(
    f.caller.setSelfProfileDisplaySetting({ ...binding, field: 'gender', value: 99 }),
  ).rejects.toThrow();
  await expect(
    f.caller.selfProfileDisplaySettings({ ...binding, uin: '10003' } as typeof binding),
  ).rejects.toThrow();
});
it('异步期间账号服务变化，旧结果拒绝返回', async () => {
  const f = fixture();
  f.accountWrite.selfProfileDisplaySettings.mockImplementationOnce(async () => {
    f.switch();
    return { targetUin: '10002', settings: [] };
  });
  await expect(f.caller.selfProfileDisplaySettings(binding)).rejects.toThrow('目标已变化');
});
