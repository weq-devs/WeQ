// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ManagedDownload,
  transferActivity,
  type TransferActivity,
} from '@weq/service/managed-download';
import { dataSaverSession } from '@weq/service/transfer-policy';
import { backgroundTasks } from '../src/main/background_tasks';
import { taskArchiveStore } from '../src/main/task_archive';
import { backgroundResult, isTaskArchived } from '../src/shared/task_archive';
import {
  dataSaverStatus,
  hostDataSaver,
  refreshTransferPolicy,
  reportDataSaverTasks,
  setTemporaryDataSaver,
  closeDataSaverWindow,
  startTransferPolicy,
} from '../src/main/data_saver';

const fixture = vi.hoisted(() => ({
  root: '',
  exports: [{ status: 'running' }],
  fail: false,
  builds: 0,
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    platform: fixture.root ? { appDataRoot: () => fixture.root } : undefined,
    bootstrap: { userConfig: { getSharedPreference: () => ({ dataSaverMode: 'always' }) } },
    services: {
      accountConfig: { getRecord: () => ({ uin: '10001', configId: 'fixture' }) },
      exportManager: { listTasks: () => fixture.exports },
      roamingBackfill: {
        list: () => {
          if (fixture.fail) throw new Error('合成读取失败');
          return [];
        },
        scanning: () => false,
      },
      flashTransferFiles: { downloads: { list: () => [] } },
      agentLab: { runningBuildCount: () => fixture.builds },
    },
  }),
}));
afterEach(() => {
  dataSaverSession.clearTemporary();
  fixture.fail = false;
  fixture.builds = 0;
  fixture.exports = [{ status: 'running' }];
  reportDataSaverTasks('window', 0);
  vi.useRealTimers();
});

it('原图下载成功后归档到原数据源，失败回执仍可重试', () => {
  startTransferPolicy();
  fixture.root = mkdtempSync(join(tmpdir(), 'weq-original-archive-'));
  const taskIds: string[] = [];
  try {
    for (const failed of [false, true]) {
      const id = globalThis.crypto.randomUUID();
      taskIds.push(id);
      const event: TransferActivity = {
        id: `download-${id}`,
        name: '下载聊天媒体',
        paused: false,
        reasons: [],
        received: 0,
        total: 10,
        transfer: new ManagedDownload({
          activityResume: { id, request: { type: 'chat-original', token: 'synthetic' } },
        }),
      };
      const archive = taskArchiveStore(fixture.root, 'fixture');
      const key = `background:host:${id}`;
      transferActivity.emit('state', event);
      expect(archive.get(key)).toBeUndefined();
      transferActivity.emit('state', {
        ...event,
        ...(failed ? { error: '模拟下载失败' } : { done: true, received: 10 }),
      });
      const task = backgroundTasks.snapshot().find((item) => item.id === id)!;
      expect(task.status).toBe(failed ? 'failed' : 'completed');
      expect(isTaskArchived(archive.get(key), backgroundResult(task))).toBe(!failed);
      if (failed) expect(task.actions).toEqual([{ id: 'retry', label: '继续下载原图' }]);
    }
  } finally {
    for (const id of taskIds) backgroundTasks.remove(id);
    rmSync(fixture.root, { recursive: true, force: true });
    fixture.root = '';
  }
});

it('窗口任务与宿主任务合计，读取失败、断连及新增任务均不能提前恢复', async () => {
  vi.useFakeTimers();
  await refreshTransferPolicy();
  reportDataSaverTasks('window', 1);
  fixture.builds = 1;
  expect(dataSaverStatus().pendingTasks).toBe(3);
  setTemporaryDataSaver({ enabled: false, duration: 'tasks' });
  fixture.exports = [];
  fixture.builds = 0;
  fixture.fail = true;
  await vi.advanceTimersByTimeAsync(3000);
  expect(dataSaverSession.status().temporary?.duration).toBe('tasks');
  fixture.fail = false;
  reportDataSaverTasks('window');
  expect(dataSaverStatus().pendingTasks).toBe(1);
  reportDataSaverTasks('window', 0);
  fixture.exports = [{ status: 'pending' }];
  await vi.advanceTimersByTimeAsync(2000);
  expect(dataSaverSession.status().temporary?.duration).toBe('tasks');
  fixture.exports = [{ status: 'paused' }];
  await vi.advanceTimersByTimeAsync(2000);
  expect(dataSaverSession.status().temporary?.duration).toBe('tasks');
  fixture.exports = [{ status: 'cancelled' }];
  await vi.advanceTimersByTimeAsync(2000);
  expect(dataSaverSession.status()).toMatchObject({
    enabled: true,
    temporary: null,
    reason: 'tasks',
  });
});
it('临时关闭使媒体入口忽略旧的 ds=1，恢复后重新限制', async () => {
  await refreshTransferPolicy();
  expect(await hostDataSaver(true)).toBe(true);
  setTemporaryDataSaver({ enabled: false, duration: 'exit' });
  expect(await hostDataSaver(true)).toBe(false);
  dataSaverSession.clearTemporary();
  expect(await hostDataSaver(false)).toBe(true);
});
it('明确页面结束才移除窗口本地任务来源，普通断连保留', async () => {
  await refreshTransferPolicy();
  fixture.exports = [];
  reportDataSaverTasks('closed-window', 2);
  reportDataSaverTasks('closed-window');
  expect(dataSaverStatus().pendingTasks).toBe(2);
  closeDataSaverWindow('closed-window');
  expect(dataSaverStatus().pendingTasks).toBe(0);
});
