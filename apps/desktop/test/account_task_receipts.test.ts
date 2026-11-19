// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { backgroundTasks } from '../src/main/background_tasks';
import { restoreRecordedTasks } from '../src/main/account_task_receipts';
import { retryRecordedClone } from '../src/main/ipc/routers/account';

const f = vi.hoisted(() => ({
  root: '',
  account: { context: { uin: '12345' }, msgDbPath: '/fixture/msg.db' },
  services: {} as object,
}));
vi.mock('../src/main/context/app_context', () => ({
  accountEventBus: new EventEmitter(),
  accountRuntimeCacheRoot: () => f.root,
  getAppContext: () => ({ account: f.account, services: f.services }),
}));

it('旧克隆构建只恢复回执，用户重跑沿用原任务并能停止；原数据源不匹配不执行', async () => {
  f.root = await mkdtemp(join(tmpdir(), 'weq-recorded-clone-'));
  const scope = { uin: '12345', configId: 'original' };
  const id = randomUUID();
  const now = Date.now();
  const params = {
    personaId: 'clone-original',
    models: { chat: { useDefault: true } },
    targetUid: 'u_original',
  };
  const outcome = Promise.withResolvers<never>();
  const agentLab = Object.assign(new EventEmitter(), {
    getPersona: vi.fn(() => null),
    buildFromC2c: vi.fn(() => outcome.promise),
    stopBuild: vi.fn(() => {
      outcome.reject(new Error('stopped'));
      return true;
    }),
  });
  const record = { uin: scope.uin, configId: scope.configId };
  f.services = { accountConfig: { getRecord: () => record }, agentLab };
  try {
    const key = createHash('sha256')
      .update(JSON.stringify([scope.uin, scope.configId, f.account.msgDbPath]))
      .digest('hex');
    const dir = join(f.root, 'task-receipts');
    await mkdir(dir);
    await writeFile(
      join(dir, `${key}.json`),
      JSON.stringify([
        {
          id,
          kind: 'clone',
          name: '合成克隆',
          startedAt: now,
          updatedAt: now,
          status: 'running',
          clonePersonaId: params.personaId,
          request: { type: 'create', params },
        },
      ]),
    );
    restoreRecordedTasks(scope, retryRecordedClone);
    expect(agentLab.buildFromC2c).not.toHaveBeenCalled();
    expect(backgroundTasks.snapshot().find((task) => task.id === id)).toMatchObject({
      status: 'failed',
      actions: [{ id: 'retry' }],
    });
    record.configId = 'other';
    await expect(backgroundTasks.act(id, 'retry')).rejects.toThrow('数据源');
    expect(agentLab.buildFromC2c).not.toHaveBeenCalled();
    record.configId = scope.configId;
    await backgroundTasks.act(id, 'retry');
    expect(agentLab.buildFromC2c).toHaveBeenCalledWith(params);
    await backgroundTasks.act(id, 'stop');
    await vi.waitFor(() =>
      expect(backgroundTasks.snapshot().find((task) => task.id === id)?.status).toBe('cancelled'),
    );
    expect(agentLab.stopBuild).toHaveBeenCalledWith(params.personaId);
  } finally {
    backgroundTasks.finish(id, 'cancelled');
    backgroundTasks.remove(id);
    await rm(f.root, { recursive: true, force: true });
  }
});
