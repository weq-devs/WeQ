// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const f = vi.hoisted(() => ({
  get: vi.fn(() => ({ id: 'valid-old_id-123' })),
  remove: vi.fn(() => true),
  saveConfig: vi.fn(() => ({})),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: '10001' } },
    services: {
      agentLab: { getPersona: f.get, deletePersona: f.remove },
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
  expect(f.get).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});

it('preserves valid historical opaque IDs', async () => {
  const caller = accountRouter.createCaller({});
  expect(await caller.getAgentLabPersona({ personaId: 'valid-old_id-123' })).toEqual({
    id: 'valid-old_id-123',
  });
  expect(await caller.deleteAgentLabPersona({ personaId: 'valid-old_id-123' })).toBe(true);
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
