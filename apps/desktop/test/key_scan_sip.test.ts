// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { scanKeyElevated } from '../src/main/key_scan_elevation';
import { isPermissionError } from '../src/main/attach_elevation';

const f = vi.hoisted(() => ({ helper: vi.fn(), password: vi.fn(), spawn: vi.fn() }));
vi.mock('@weq/native', async (original) => ({
  ...(await original<typeof import('@weq/native')>()),
  readSipEnabled: () => true,
}));
vi.mock('../src/main/authorization/client', () => ({ tryLongTermKeyScan: f.helper }));
vi.mock('../src/main/sudo_prompt', () => ({ requestSudoPassword: f.password }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: f.spawn,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const options = { dbPath: '/synthetic/nt_msg.db', pid: 42, runInProcess: vi.fn() };
it('SIP 开启的扫描失败后仍允许带权限助手兜底，不提前拒绝', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  const result = { success: true, key: 'synthetic-only' };
  f.helper.mockResolvedValue(result);
  await expect(scanKeyElevated(options)).resolves.toBe(result);
  expect(f.password).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});
it('SIP 开启且助手不可读时提示副本，不启动无效 sudo', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  f.helper.mockRejectedValue(new Error('task_for_pid failed'));
  await expect(scanKeyElevated(options)).rejects.toThrow('调试副本');
  expect(f.password).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});
it('扫描器的中英文 task_for_pid 拒绝均可进入现有助手重试，普通解析错误不可', () => {
  for (const message of [
    'task_for_pid failed for pid 42 (kern_return 5)',
    'task_for_pid 失败',
    'Operation not permitted',
  ])
    expect(isPermissionError(new Error(message))).toBe(true);
  expect(isPermissionError(new Error('invalid database header'))).toBe(false);
});
