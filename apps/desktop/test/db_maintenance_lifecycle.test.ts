import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { DatabaseMaintenanceSnapshot } from '@weq/service';
import {
  guardDatabaseMaintenanceQuit,
  guardDatabaseMaintenanceWindow,
} from '../src/main/db_maintenance_lifecycle';

const snapshot = (state: DatabaseMaintenanceSnapshot['state']): DatabaseMaintenanceSnapshot => ({
  id: 'session',
  uin: 'synthetic',
  state,
  locked: true,
  databases: [],
});
const settle = async () => {
  for (let count = 0; count < 10; count++) await Promise.resolve();
};

it('等待决定时取消关闭继续持锁，确认放弃后等全部解锁才关闭窗口', async () => {
  const events = new EventEmitter();
  const order: string[] = [];
  const close = vi.fn(() => order.push('closed'));
  const confirm = vi.fn(async () => false);
  const end = vi.fn(async () => {
    order.push('unlocked');
  });
  guardDatabaseMaintenanceWindow(
    { on: events.on.bind(events), close },
    {
      quitting: () => false,
      current: () => snapshot('waiting'),
      confirmEnd: confirm,
      end,
      failed: (error) => {
        throw error;
      },
    },
  );
  const event = { preventDefault: vi.fn() };
  events.emit('close', event);
  await settle();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(end).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  confirm.mockResolvedValueOnce(true);
  events.emit('close', event);
  await settle();
  expect(order).toEqual(['unlocked', 'closed']);
});

it('修复已经开始，关闭窗口不取消后台任务', () => {
  const events = new EventEmitter();
  const confirmEnd = vi.fn();
  const end = vi.fn();
  guardDatabaseMaintenanceWindow(
    { on: events.on.bind(events), close: vi.fn() },
    {
      quitting: () => false,
      current: () => snapshot('repairing'),
      confirmEnd,
      end,
      failed: vi.fn(),
    },
  );
  const event = { preventDefault: vi.fn() };
  events.emit('close', event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(confirmEnd).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
});

it('关窗确认期间任务已经开始修复时，转为只关闭界面，不再结束维护', async () => {
  const events = new EventEmitter();
  let state: DatabaseMaintenanceSnapshot['state'] = 'waiting';
  const close = vi.fn();
  const end = vi.fn();
  guardDatabaseMaintenanceWindow(
    { on: events.on.bind(events), close },
    {
      quitting: () => false,
      current: () => snapshot(state),
      confirmEnd: async () => {
        state = 'repairing';
        return true;
      },
      end,
      failed: vi.fn(),
    },
  );
  events.emit('close', { preventDefault: vi.fn() });
  await settle();
  expect(close).toHaveBeenCalledOnce();
  expect(end).not.toHaveBeenCalled();
});

it('修复中退出询问是否停止，取消不动任务，确认后等停止和报告收尾再退出', async () => {
  const events = new EventEmitter();
  const quit = vi.fn();
  const confirmStop = vi.fn(async () => false);
  let stopped!: () => void;
  const stop = vi.fn(
    () =>
      new Promise<void>((done) => {
        stopped = done;
      }),
  );
  guardDatabaseMaintenanceQuit(
    { on: events.on.bind(events), quit },
    {
      repairing: () => true,
      confirmStop,
      stop,
      cancelled: vi.fn(),
      failed: (error) => {
        throw error;
      },
    },
  );
  events.emit('before-quit', { preventDefault: vi.fn() });
  await settle();
  expect(stop).not.toHaveBeenCalled();
  confirmStop.mockResolvedValueOnce(true);
  events.emit('before-quit', { preventDefault: vi.fn() });
  await settle();
  expect(stop).toHaveBeenCalledOnce();
  expect(quit).not.toHaveBeenCalled();
  stopped();
  await settle();
  expect(quit).toHaveBeenCalledOnce();
});

it('一次退出在别处取消后，之后的新修复退出仍需重新确认', async () => {
  const events = new EventEmitter();
  let active = true;
  const confirmStop = vi.fn(async () => true);
  guardDatabaseMaintenanceQuit(
    { on: events.on.bind(events), quit: vi.fn() },
    {
      repairing: () => active,
      confirmStop,
      stop: async () => {
        active = false;
      },
      cancelled: vi.fn(),
      failed: vi.fn(),
    },
  );
  events.emit('before-quit', { preventDefault: vi.fn() });
  await settle();
  active = true;
  events.emit('before-quit', { preventDefault: vi.fn() });
  await settle();
  expect(confirmStop).toHaveBeenCalledTimes(2);
});

it('从历史备份恢复期间等待文件操作完成后再退出', async () => {
  const events = new EventEmitter();
  const quit = vi.fn();
  const preventDefault = vi.fn();
  const confirmStop = vi.fn(async () => true);
  const restore = Promise.withResolvers<void>();
  guardDatabaseMaintenanceQuit(
    { on: events.on.bind(events), quit },
    {
      repairing: () => false,
      restoring: () => restore.promise,
      confirmStop,
      stop: vi.fn(async () => {}),
      cancelled: vi.fn(),
      failed: vi.fn(),
    },
  );
  events.emit('before-quit', { preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(quit).not.toHaveBeenCalled();
  expect(confirmStop).not.toHaveBeenCalled();
  restore.resolve();
  await settle();
  expect(quit).toHaveBeenCalledOnce();
});
