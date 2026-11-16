import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { dbRepairRouter } from '../src/main/ipc/routers/db_repair';

const state = vi.hoisted(() => ({
  root: '',
  configs: [] as Array<{
    uin: string;
    configId: string;
    dataDir: string;
    dbKey: string;
    algos: object;
  }>,
}));
vi.mock('../src/main/context/app_context', () => ({
  requireBootstrap: () => ({
    userConfig: {
      listAccountConfigs: () => state.configs,
      cacheDir: (path: string) => join(state.root, 'cache', path),
      getDbRepairCacheDir: () => null,
    },
  }),
  requirePlatform: () => ({
    ntDbDir: () => join(state.root, 'online'),
    ntMsgDbPath: () => join(state.root, 'online', 'nt_msg.db'),
    resolveQqPid: () => null,
  }),
  getAppContext: () => ({}),
  closeSalvageConnections: vi.fn(),
}));
vi.mock('../src/main/ipc/trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.create();
  return { procedure: t.procedure, router: t.router };
});
vi.mock('../src/main/background_tasks', () => ({
  backgroundTasks: {},
  runBackgroundTask: vi.fn(),
}));
vi.mock('../src/main/db_checkup', () => ({ databaseCheckups: {} }));

afterEach(async () => {
  if (state.root) await rm(state.root, { recursive: true, force: true });
});
it('修复入口按任务的数据源解析，同号备份不串库，显式来源失效时不退回在线库', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-repair-source-'));
  for (const id of ['online', 'backup']) {
    await mkdir(join(state.root, id));
    await writeFile(join(state.root, id, 'nt_msg.db'), 'synthetic');
  }
  state.configs = ['online', 'backup'].map((configId) => ({
    uin: '10001',
    configId,
    dataDir: join(state.root, configId),
    dbKey: 'fixture',
    algos: {},
  }));
  const caller = dbRepairRouter.createCaller({});
  const [backup, online] = await Promise.all([
    caller.status({ uin: '10001', configId: 'backup' }),
    caller.status({ uin: '10001', configId: 'online' }),
  ]);
  expect(backup.dbDir).toBe(join(state.root, 'backup'));
  expect(online.dbDir).toBe(join(state.root, 'online'));
  expect((await caller.status({ uin: '10001', configId: 'missing' })).dbDir).toBe('');
  await rm(join(state.root, 'backup', 'nt_msg.db'));
  expect((await caller.status({ uin: '10001', configId: 'backup' })).dbDir).toBe('');
});
