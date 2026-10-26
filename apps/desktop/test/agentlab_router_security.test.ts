// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const f = vi.hoisted(() => ({
  get: vi.fn(() => ({ id: 'valid-old_id-123' })),
  remove: vi.fn(() => true),
  refresh: vi.fn(async () => ({ id: 'valid-old_id-123' })),
  saveConfig: vi.fn(() => ({})),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: '10001' } },
    services: {
      agentLab: { getPersona: f.get, deletePersona: f.remove, refreshFromC2c: f.refresh },
      assistant: { setConfig: f.saveConfig },
    },
  }),
}));
beforeEach(() => vi.clearAllMocks());

it.each([
  '../outside',
  '..\\outside',
  '/tmp/outside',
  'C:\\outside',
  '%2e%2e%2foutside',
  '.',
  'a\0b',
])('actual persona routes reject %j before calling a service', async (personaId) => {
  const caller = accountRouter.createCaller({});
  await expect(caller.getAgentLabPersona({ personaId })).rejects.toThrow('克隆 ID 无效');
  await expect(caller.deleteAgentLabPersona({ personaId })).rejects.toThrow('克隆 ID 无效');
  await expect(
    caller.refreshAgentLabFromC2c({ personaId, expectedAccountUin: '10001' }),
  ).rejects.toThrow('克隆 ID 无效');
  expect(f.get).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
});

it('preserves valid historical opaque IDs', async () => {
  const caller = accountRouter.createCaller({});
  expect(await caller.getAgentLabPersona({ personaId: 'valid-old_id-123' })).toEqual({
    id: 'valid-old_id-123',
  });
  expect(await caller.deleteAgentLabPersona({ personaId: 'valid-old_id-123' })).toBe(true);
  await caller.refreshAgentLabFromC2c({
    personaId: 'valid-old_id-123',
    expectedAccountUin: '10001',
  });
  expect(f.refresh).toHaveBeenCalledWith('valid-old_id-123');
});

it('更新克隆请求到达前账号已切换时拒绝操作', async () => {
  const caller = accountRouter.createCaller({});
  await expect(
    caller.refreshAgentLabFromC2c({ personaId: 'valid-old_id-123', expectedAccountUin: '10002' }),
  ).rejects.toThrow('账号已切换');
  expect(f.refresh).not.toHaveBeenCalled();
});

it('validates permission mode and forwards explicit risk acknowledgment to the service', async () => {
  const caller = accountRouter.createCaller({});
  await expect(
    caller.setAssistantConfig(JSON.parse('{"permissionMode":"arbitrary"}')),
  ).rejects.toThrow();
  expect(f.saveConfig).not.toHaveBeenCalled();
  await caller.setAssistantConfig({ permissionMode: 'unrestricted', confirmUnrestricted: true });
  expect(f.saveConfig).toHaveBeenCalledWith(
    expect.objectContaining({ permissionMode: 'unrestricted', confirmUnrestricted: true }),
  );
});
