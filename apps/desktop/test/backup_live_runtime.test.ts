// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { applyBackupLive } from '../src/main/context/runtime_files';
import { runtimeMaintenance } from '../src/main/runtime_maintenance';

const f = vi.hoisted(() => ({
  closing: vi.fn(async (_wait?: boolean) => {}),
  stop: vi.fn(async () => {}),
  apply: vi.fn(() => ({ status: 'applied', warnings: [] as string[], needsRecovery: false })),
  blocked: vi.fn(),
  repairBusy: false,
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ bootstrap: null, clearAccount: f.closing }),
  blockRuntimeForBackupRecovery: f.blocked,
}));
vi.mock('../src/main/context/backup_context', () => ({ applyLiveBackupContext: f.apply }));
vi.mock('../src/main/ipc/routers/db_repair', () => ({ isDbRepairBusy: () => f.repairBusy }));
vi.mock('../src/main/ipc/routers/intent_sense', () => ({ isIntentModelDownloading: () => false }));
vi.mock('../src/main/weq_assistant/server', () => ({ assistantResourceServer: { stop: f.stop } }));
afterEach(() => {
  vi.clearAllMocks();
  f.repairBusy = false;
});

it('等待账号后台写入完成并停止助手后，才应用恢复；整个过程不调用重启', async () => {
  let release!: () => void;
  f.closing.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
  const stage = vi.fn();
  const work = applyBackupLive(stage);
  expect(stage).toHaveBeenCalledOnce();
  expect(f.closing).toHaveBeenCalledWith(true);
  expect(f.apply).not.toHaveBeenCalled();
  expect(runtimeMaintenance.status().state).toBe('maintenance');
  release();
  await work;
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(f.apply.mock.invocationCallOrder[0]!);
  expect(f.apply).toHaveBeenCalledOnce();
  expect(runtimeMaintenance.status().state).toBe('ready');
});

it('数据库修复在途时不暂存、不关闭账号、不替换文件', async () => {
  f.repairBusy = true;
  const stage = vi.fn();
  await expect(applyBackupLive(stage)).rejects.toThrow('数据库修复');
  expect(stage).not.toHaveBeenCalled();
  expect(f.closing).not.toHaveBeenCalled();
  expect(f.apply).not.toHaveBeenCalled();
});

it('旧服务收尾失败时不应用事务，保留失败原因并释放维护状态', async () => {
  f.closing.mockRejectedValueOnce(new Error('synthetic-flush-failed'));
  await expect(applyBackupLive()).rejects.toThrow('synthetic-flush-failed');
  expect(f.apply).not.toHaveBeenCalled();
  expect(runtimeMaintenance.status().state).toBe('ready');
});
