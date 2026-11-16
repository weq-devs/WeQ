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
  for (const task of backgroundTasks.snapshot()) {
    backgroundTasks.finish(task.id, 'cancelled');
    backgroundTasks.remove(task.id);
  }
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
