// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { dataSaverSession } from '@weq/service/transfer-policy';
import {
  dataSaverStatus,
  hostDataSaver,
  refreshTransferPolicy,
  reportDataSaverTasks,
  setTemporaryDataSaver,
  closeDataSaverWindow,
} from '../src/main/data_saver';

const fixture = vi.hoisted(() => ({ exports: [{ status: 'running' }], fail: false, builds: 0 }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    bootstrap: { userConfig: { getSharedPreference: () => ({ dataSaverMode: 'always' }) } },
    services: {
      accountConfig: { getRecord: () => ({ configId: 'fixture' }) },
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
