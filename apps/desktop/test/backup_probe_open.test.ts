import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';

const f = vi.hoisted(() => ({
  probe: vi.fn(),
  open: vi.fn(),
  ctx: { account: { context: { uin: '12345' } } },
}));
vi.mock('../src/main/backup_probe', () => ({ runBackupProbe: f.probe }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ ...f.ctx, setStaticAccount: f.open }),
}));
const roots: string[] = [];
const preview = { uin: '12345', uid: 'u_synthetic', displayName: '合成账号', avatarUrl: '' };
beforeEach(() => {
  vi.resetAllMocks();
  f.probe.mockResolvedValue({ status: 'ready', preview, mobile: false });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-open-probe-'));
  roots.push(dir);
  for (const name of ['nt_msg.db', 'profile_info.db']) writeFileSync(join(dir, name), 'synthetic');
  return dir;
}
const caller = bootstrapRouter.createCaller({});
it('隔离预检未成功或账号变化时，旧入口不能直接在主进程打开数据库', async () => {
  const dirPath = fixture();
  for (const result of [
    { status: 'needKey' },
    { status: 'error', error: 'synthetic invalid database' },
    { status: 'ready', preview: { ...preview, uin: '99999' } },
  ]) {
    f.probe.mockResolvedValueOnce(result);
    await expect(caller.openStaticAccount({ dirPath, preview })).rejects.toThrow();
  }
  f.probe.mockRejectedValueOnce(new Error('worker SIGSEGV 已隔离'));
  await expect(caller.openStaticAccount({ dirPath, preview })).rejects.toThrow('已隔离');
  expect(f.open).not.toHaveBeenCalled();
});
it('预检得到的 Android 密钥会交给实际会话，而不是再次在主进程推导', async () => {
  const dirPath = fixture();
  f.probe.mockResolvedValueOnce({
    status: 'ready',
    preview,
    mobile: true,
    dbKey: 'derived-synthetic',
  });
  await caller.openStaticAccount({ dirPath, preview });
  expect(f.open).toHaveBeenCalledWith(expect.any(String), preview, {
    dbKey: 'derived-synthetic',
    mobile: true,
  });
});
