import { afterEach, expect, it, vi } from 'vitest';
import { DbRepairService } from '@weq/service';
import { dbRepairRouter } from '../src/main/ipc/routers/db_repair';
import { backgroundTasks } from '../src/main/background_tasks';

const fixture = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn() }));
vi.mock('../src/main/db_checkup', () => ({ databaseCheckups: fixture }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({}),
  requireBootstrap: vi.fn(),
  requirePlatform: vi.fn(),
  closeSalvageConnections: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const task of backgroundTasks.snapshot()) {
    backgroundTasks.finish(task.id, 'cancelled');
    backgroundTasks.remove(task.id);
  }
});

it('关页移除本页所有结果与重试生成的记录，不删除其他页面或实际备份', async () => {
  vi.spyOn(DbRepairService.prototype, 'resolveTarget').mockReturnValue({
    uin: 'synthetic',
    dbName: 'nt_msg.db',
    dbPath: '/synthetic/nt_msg.db',
    dbDir: '/synthetic',
    dataDir: null,
    key: 'synthetic',
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA1' },
  });
  fixture.start.mockRejectedValueOnce(new Error('合成检查失败'));
  fixture.start.mockResolvedValue({ summary: '合成体检完成' });
  const caller = dbRepairRouter.createCaller({});
  const input = { uin: 'synthetic', dbName: 'nt_msg.db', taskId: 'original', ownerId: 'page-a' };
  await expect(caller.checkup(input)).rejects.toThrow('合成检查失败');
  await backgroundTasks.act(backgroundTasks.snapshot()[0]!.id, 'retry');
  await caller.checkup({ ...input, ownerId: 'page-b', taskId: 'other' });
  const backup = backgroundTasks.start({ kind: 'backup', name: '备份', scope: { uin: input.uin } });
  backgroundTasks.finish(backup, 'completed');
  expect(backgroundTasks.snapshot()).toHaveLength(4);
  await caller.releaseCheckups({ uin: 'other-account', ownerId: input.ownerId });
  expect(backgroundTasks.snapshot()).toHaveLength(4);
  await caller.releaseCheckups({ uin: input.uin, ownerId: input.ownerId });
  expect(backgroundTasks.snapshot().map((task) => task.ownerId ?? task.id)).toEqual([
    'page-b',
    backup,
  ]);
});

it('释放页面时取消仍在运行的重试，实际退出前保留任务且迟到结果不重建记录', async () => {
  vi.spyOn(DbRepairService.prototype, 'resolveTarget').mockReturnValue({
    uin: 'synthetic',
    dbName: 'nt_msg.db',
    dbPath: '/synthetic/nt_msg.db',
    dbDir: '/synthetic',
    dataDir: null,
    key: 'synthetic',
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA1' },
  });
  const caller = dbRepairRouter.createCaller({});
  const input = { uin: 'synthetic', dbName: 'nt_msg.db', taskId: 'running', ownerId: 'page-a' };
  fixture.start.mockRejectedValueOnce(new Error('合成检查失败'));
  await expect(caller.checkup(input)).rejects.toThrow('合成检查失败');
  const failedId = backgroundTasks.snapshot()[0]!.id;
  let reject!: (error: Error) => void;
  fixture.start.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  fixture.cancel.mockImplementationOnce(async () => {
    expect(backgroundTasks.snapshot().at(-1)?.status).toBe('running');
    reject(new Error('体检已停止'));
    return { cancelled: true };
  });
  const pending = backgroundTasks.act(failedId, 'retry');
  const stopped = expect(pending).rejects.toThrow('已停止');
  await vi.waitFor(() => expect(reject).toBeDefined());
  await caller.releaseCheckups({ uin: input.uin, ownerId: input.ownerId });
  await stopped;
  expect(fixture.cancel).toHaveBeenCalledWith(input.uin, input.taskId);
  expect(backgroundTasks.snapshot()).toEqual([]);
});

it('体检取消后保留重新体检入口，重试重新解析原账号数据库且不重复启动', async () => {
  const target = vi.spyOn(DbRepairService.prototype, 'resolveTarget').mockReturnValue({
    uin: 'synthetic',
    dbName: 'nt_msg.db',
    dbPath: '/synthetic/nt_msg.db',
    dbDir: '/synthetic',
    dataDir: null,
    key: 'synthetic',
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA1' },
  });
  let reject!: (error: Error) => void;
  fixture.start.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  fixture.cancel.mockImplementationOnce(async () => {
    reject(new Error('体检已停止'));
    return { cancelled: true };
  });
  const caller = dbRepairRouter.createCaller({});
  const input = { uin: 'synthetic', dbName: 'nt_msg.db', taskId: 'original' };
  const running = caller.checkup(input);
  const stopped = expect(running).rejects.toThrow('已停止');
  await vi.waitFor(() => expect(reject).toBeDefined());
  await expect(caller.checkup(input)).rejects.toThrow('已经在运行');
  expect(backgroundTasks.snapshot()).toHaveLength(1);
  const id = backgroundTasks.snapshot()[0]!.id;
  await backgroundTasks.act(id, 'stop');
  await stopped;
  expect(backgroundTasks.snapshot()[0]).toMatchObject({
    status: 'cancelled',
    actions: [{ id: 'retry', label: '重新体检' }],
  });
  fixture.start.mockResolvedValueOnce({ summary: '合成体检完成' });
  await backgroundTasks.act(id, 'retry');
  expect(target).toHaveBeenNthCalledWith(3, input.uin, input.dbName);
  expect(backgroundTasks.snapshot().at(-1)).toMatchObject({
    status: 'completed',
    note: '合成体检完成',
  });
  expect(fixture.start).toHaveBeenCalledTimes(2);
});
