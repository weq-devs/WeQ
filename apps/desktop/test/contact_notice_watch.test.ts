import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DbWatchTask, DbChange } from '@weq/service';
import { mountContactNoticeWatch } from '../src/main/contact_notice_watch';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbWatchService } from '../../../packages/service/src/account/db_watch';

const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(
  kind: 'friend' | 'group' = 'friend',
  read = vi.fn(async () => [{ id: 1n, status: 0 }]),
) {
  let active = true;
  let task: DbWatchTask;
  const notify = vi.fn();
  const unmount = vi.fn();
  const mount = vi.fn((value: DbWatchTask) => {
    task = value;
    return { unmount };
  });
  const dbPath = `/fixture/${kind}.db`;
  const handle = mountContactNoticeWatch({ mount }, { kind, dbPath, read }, () => active, notify);
  cleanups.push(handle.unmount);
  return {
    read,
    notify,
    mount,
    unmount,
    handle,
    change: () => task.onDbFileChangeHook({ dbPath, at: Date.now() } as DbChange),
    switchAccount: () => {
      active = false;
    },
  };
}

it.each(['friend', 'group'] as const)(
  '为 %s 挂载实际库；首次同步后无变化不重复通知',
  async (kind) => {
    const f = fixture(kind);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.mount.mock.calls[0]?.[0].dbPath).toBe(`/fixture/${kind}.db`);
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledWith(kind);
    f.change();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.read).toHaveBeenCalledTimes(2);
  },
);

it('新增、处理和删除都会推送，同时间行重排不会误报', async () => {
  const f = fixture();
  const a = { id: 9007199254740993n, status: 0 };
  const b = { id: 9007199254740994n, status: 0 };
  await vi.advanceTimersByTimeAsync(0);
  for (const rows of [[a, b], [b, a], [{ ...a, status: 1 }, b], []]) {
    f.read.mockResolvedValue(rows);
    f.change();
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(f.notify).toHaveBeenCalledTimes(4);
});

it('连续资料库事件每秒最多读一轮，持续变化不会饿死通知', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.read.mockResolvedValue([{ id: 2n, status: 0 }]);
  for (let i = 0; i < 30; i++) {
    f.change();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(f.read).toHaveBeenCalledTimes(4);
  expect(f.notify).toHaveBeenCalledTimes(2);
});

it('读取中发生的文件变化补读一次，不并发读取同一小表', async () => {
  let resolve!: (rows: Array<{ id: bigint; status: number }>) => void;
  const read = vi.fn(
    () =>
      new Promise<Array<{ id: bigint; status: number }>>((done) => {
        resolve = done;
      }),
  );
  const f = fixture('group', read);
  f.change();
  f.change();
  await vi.advanceTimersByTimeAsync(2000);
  expect(read).toHaveBeenCalledTimes(1);
  resolve([{ id: 1n, status: 0 }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(2);
  resolve([{ id: 1n, status: 1 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.notify).toHaveBeenCalledTimes(2);
});

it('短暂读取失败自行退避重试，不需要下一条文件事件', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = vi.fn(async () => [{ id: 1n, status: 0 }]);
  read.mockRejectedValueOnce(new Error('busy'));
  const f = fixture('friend', read);
  await vi.advanceTimersByTimeAsync(999);
  expect(f.notify).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.notify).toHaveBeenCalledTimes(1);
  expect(f.notify).toHaveBeenCalledWith('friend');
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(['switch', 'unmount'] as const)('%s 后丢弃迟到快照并停止后续读取', async (action) => {
  let resolve!: (rows: Array<{ id: bigint; status: number }>) => void;
  const read = vi.fn(
    () =>
      new Promise<Array<{ id: bigint; status: number }>>((done) => {
        resolve = done;
      }),
  );
  const f = fixture('friend', read);
  f.change();
  if (action === 'switch') f.switchAccount();
  else f.handle.unmount();
  resolve([{ id: 1n, status: 0 }]);
  await vi.advanceTimersByTimeAsync(30_000);
  f.change();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.notify).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
  f.handle.unmount();
  f.handle.unmount();
  expect(f.unmount).toHaveBeenCalledTimes(1);
});

it('主库文件不变，仅 WAL 写入也能触发通知，无需任何消息库活动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-contact-notice-'));
  const dbPath = join(root, 'fixture.db');
  const watcher = new DbWatchService();
  let rows = [{ id: 1n }];
  const notify = vi.fn();
  await writeFile(dbPath, 'fixture');
  const handle = mountContactNoticeWatch(
    watcher,
    { kind: 'friend', dbPath, read: async () => rows },
    () => true,
    notify,
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledTimes(1);
    rows = [{ id: 2n }];
    await writeFile(`${dbPath}-wal`, 'new notification');
    watcher.pollNow();
    await vi.advanceTimersByTimeAsync(1100);
    expect(notify).toHaveBeenCalledTimes(2);
  } finally {
    handle.unmount();
    watcher.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('已建立快照后读取失败保留旧结果，卸载取消排队重试', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.read.mockRejectedValue(new Error('busy'));
  f.change();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.notify).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledTimes(2);
  f.handle.unmount();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.read).toHaveBeenCalledTimes(2);
});
