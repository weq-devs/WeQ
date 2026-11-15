import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataSaverSession, networkCost, UNKNOWN_NETWORK } from '../src/common/data_saver';
import {
  dataSaverSession,
  transferCanResume,
  transferRestricted,
  updateTransferPolicy,
} from '../src/common/transfer_policy';
import { scopedNetworkAllowed } from '../src/common/network_scope';
import { ManagedDownload } from '../src/common/managed_download';

let session: DataSaverSession;
const restricted = networkCost(true, false, 'fixture');
const normal = networkCost(false, false, 'fixture');
beforeEach(() => {
  vi.useFakeTimers();
  session = new DataSaverSession();
});
afterEach(() => {
  session.dispose();
  dataSaverSession.clearTemporary();
  updateTransferPolicy('auto', normal);
  vi.useRealTimers();
});

it('基础三态、宿主和本端系统状态分别计算，unknown 不产生虚假退出', () => {
  session.update('auto', normal);
  session.updateClient('phone', restricted);
  expect(session.status().enabled).toBe(false);
  expect(session.status('phone').enabled).toBe(true);
  session.updateClient('phone', UNKNOWN_NETWORK);
  expect(session.status('phone').enabled).toBe(true);
  session.update('auto', restricted);
  session.update('auto', UNKNOWN_NETWORK);
  expect(session.status().host).toEqual(restricted);
  session.update('never', restricted);
  expect(session.status('phone').enabled).toBe(false);
  session.update('always', normal);
  expect(session.status().enabled).toBe(true);
});
it('临时关闭优先于系统限制并由所有端共用，到期恢复当时系统状态', async () => {
  session.update('auto', restricted);
  session.updateClient('phone', restricted);
  session.setTemporary({ enabled: false, duration: 'minutes', minutes: 1 });
  expect(session.status('phone')).toMatchObject({
    mode: 'auto',
    effectiveMode: 'never',
    enabled: false,
    reason: 'temporary',
  });
  await vi.advanceTimersByTimeAsync(60000);
  expect(session.status('phone')).toMatchObject({
    enabled: true,
    temporary: null,
    reason: 'expiry',
  });
});
it('临时开启到期自动退出，替换期限取消旧计时器', async () => {
  session.update('never', restricted);
  session.setTemporary({ enabled: true, duration: 'minutes', minutes: 1 });
  session.setTemporary({ enabled: false, duration: 'exit' });
  await vi.advanceTimersByTimeAsync(60000);
  expect(session.status().temporary?.duration).toBe('exit');
  session.clearTemporary();
  session.setTemporary({ enabled: true, duration: 'minutes', minutes: 1 });
  await vi.advanceTimersByTimeAsync(60000);
  expect(session.status()).toMatchObject({ enabled: false, reason: 'expiry', temporary: null });
});
it('修改基础设置清除覆盖，系统变化不清除覆盖', () => {
  session.setTemporary({ enabled: true, duration: 'exit' });
  session.update('auto', restricted);
  expect(session.status().temporary).not.toBeNull();
  session.update('never', restricted);
  expect(session.status()).toMatchObject({ enabled: false, temporary: null, reason: 'settings' });
});
it('任务期限只允许临时关闭，未知及无任务时拒绝；新增任务继续等待', () => {
  expect(() => session.setTemporary({ enabled: false, duration: 'tasks' })).toThrow('未完成任务');
  session.setPendingTasks(0);
  expect(() => session.setTemporary({ enabled: false, duration: 'tasks' })).toThrow('未完成任务');
  session.update('always', normal);
  session.setPendingTasks(2);
  session.setTemporary({ enabled: false, duration: 'tasks' });
  for (const count of [1, 3, null, 1]) {
    session.setPendingTasks(count);
    session.finishTasks();
    expect(session.status().temporary).not.toBeNull();
  }
  session.setPendingTasks(0);
  session.finishTasks();
  expect(session.status()).toMatchObject({ enabled: true, temporary: null, reason: 'tasks' });
});
it.each([0, -1, 1.5, NaN, Infinity, 1441])('无效分钟数 %s 不改变当前覆盖', (minutes) => {
  session.setTemporary({ enabled: true, duration: 'exit' });
  expect(() => session.setTemporary({ enabled: false, duration: 'minutes', minutes })).toThrow(
    '分钟数',
  );
  expect(session.status().temporary?.enabled).toBe(true);
});
it('宿主退出丢弃临时覆盖，不向下一进程恢复', () => {
  session.setTemporary({ enabled: true, duration: 'exit' });
  const next = new DataSaverSession();
  expect(next.status().temporary).toBeNull();
  expect(next.status().sessionId).not.toBe(session.status().sessionId);
  next.dispose();
});
it('临时覆盖真正接入后台网络与任务恢复判断', () => {
  updateTransferPolicy('auto', restricted, { dataSaverDress: false });
  expect(scopedNetworkAllowed('dress')).toBe(false);
  dataSaverSession.setTemporary({ enabled: false, duration: 'exit' });
  expect(transferRestricted('phone')).toBe(false);
  expect(transferCanResume('phone')).toBe(true);
  expect(scopedNetworkAllowed('dress')).toBe(true);
  dataSaverSession.clearTemporary();
  expect(transferRestricted()).toBe(true);
});
it('临时关闭不会解除用户手动暂停，显式继续才读取下载结果', async () => {
  vi.useRealTimers();
  updateTransferPolicy('always', restricted);
  const download = new ManagedDownload({ batch: true });
  download.pause();
  const done = vi.fn();
  const reading = download.response(new Response('fixture')).text().then(done);
  dataSaverSession.setTemporary({ enabled: false, duration: 'exit' });
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  download.continue();
  await reading;
  expect(done).toHaveBeenCalledWith('fixture');
});
