// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { NtHelperBinding } from '@weq/native';
import { DebugReadUnavailableError, type UserConfigService } from '@weq/service';
import { createLinuxAttachHook } from '../src/main/attach_elevation';

const f = vi.hoisted(() => ({ helper: vi.fn(), password: vi.fn() }));
vi.mock('@weq/native', async (original) => ({
  ...(await original<typeof import('@weq/native')>()),
  readSipEnabled: () => true,
}));
vi.mock('../src/main/authorization/client', () => ({ tryLongTermAttach: f.helper }));
vi.mock('../src/main/sudo_prompt', () => ({
  getSudoPasswordPrompt: () => f.password,
  requestSudoPassword: f.password,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function fixture() {
  vi.stubGlobal('process', { ...process, platform: 'darwin', geteuid: () => 501 });
  const scan = vi.fn();
  const hook = createLinuxAttachHook(
    { scanSessionMaterial: scan } as unknown as NtHelperBinding,
    {} as UserConfigService,
  );
  return { scan, hook };
}
it('SIP 开启仍先读调试副本，不在成功时调用助手或索要密码', async () => {
  const { scan, hook } = fixture();
  const material = { a2: 'aa', d2: 'bb', d2Key: 'cc' };
  scan.mockResolvedValue(material);
  await expect(hook.ensure(42, { uin: 'fixture' })).resolves.toBe(material);
  expect(scan).toHaveBeenCalledWith(42, 'fixture', undefined);
  expect(f.helper).not.toHaveBeenCalled();
  expect(f.password).not.toHaveBeenCalled();
});
it('直接读取被拒后允许带 entitlement 助手兜底', async () => {
  const { scan, hook } = fixture();
  scan.mockRejectedValue(new Error('task_for_pid 失败'));
  f.helper.mockResolvedValue({ a2: 'aa', d2: 'bb', d2Key: 'cc' });
  await expect(hook.ensure(42, {})).resolves.toHaveProperty('a2', 'aa');
  expect(f.password).not.toHaveBeenCalled();
});
it('权限路径均失败才提示调试副本，不尝试无效的 sudo', async () => {
  const { scan, hook } = fixture();
  scan.mockRejectedValue(new Error('task_for_pid 失败'));
  f.helper.mockRejectedValue(new Error('permission denied'));
  await expect(hook.ensure(42, {})).rejects.toBeInstanceOf(DebugReadUnavailableError);
  expect(f.password).not.toHaveBeenCalled();
});
it('非权限错误原样返回，不误报 SIP 或尝试助手', async () => {
  const { scan, hook } = fixture();
  scan.mockRejectedValue(new Error('wrapper.node not mapped'));
  await expect(hook.ensure(42, {})).rejects.toThrow('wrapper.node not mapped');
  expect(f.helper).not.toHaveBeenCalled();
});
