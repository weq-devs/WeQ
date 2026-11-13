// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const start = vi.hoisted(() => vi.fn(async () => 'synthetic-task'));
vi.mock('../src/main/context/app_context', () => ({
  accountEventBus: new EventEmitter(),
  getAppContext: () => ({
    account: { context: { uin: '10001' } },
    services: { exportManager: { startTask: start } },
  }),
}));
beforeEach(() => vi.clearAllMocks());

it.each([
  ['official', 'u_synthetic_official'],
  ['service', '1234567'],
] as const)('真实 startExport 接受 %s 并原样传递会话来源和身份', async (kind, conv) => {
  const caller = accountRouter.createCaller({});
  expect(
    await caller.startExport({
      expectedAccountUin: '10001',
      kind,
      conv,
      name: '合成订阅',
      format: 'txt',
      total: 0,
    }),
  ).toBe('synthetic-task');
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ kind, conv }));
});
