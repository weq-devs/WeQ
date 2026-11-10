import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import {
  databasePerformance,
  databaseRequestSignal,
  scheduleDatabase,
  withDatabasePriority,
} from '@weq/db';
import { UnreadInfoService } from '../src/account/unread_info';

afterEach(() => vi.unstubAllEnvs());
const target = [{ chatType: 2, uid: '70001' }];
function fixture(path: string) {
  const binding = {};
  const queried = vi.fn(async () => []);
  const signals: Array<AbortSignal | undefined> = [];
  const getUnreadInfos = vi.fn(async () => {
    signals.push(databaseRequestSignal());
    await scheduleDatabase(path, queried, binding);
    return [
      { chatType: 2, uid: '70001', peer: '2_70001', msgSeq: 1, latestSeq: '2', outgoingSeqs: [] },
    ];
  });
  const service = new UnreadInfoService({
    selfUid: 'u_self',
    context: { uin: '10001' },
    msgDbPath: path,
    unreadInfo: { getUnreadInfos },
  } as unknown as AccountSession);
  return { service, binding, queried, signals, getUnreadInfos };
}

it('完整未读补算后台执行，轻量水位仍走交互通道且不读取自己发言', async () => {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '1');
  const path = '/synthetic/unread-priority.db',
    f = fixture(path);
  await f.service.getUnreadInfos(target);
  await f.service.getUnreadInfos(target, true);
  expect(f.getUnreadInfos.mock.calls[0]).toEqual([
    target,
    { selfUid: 'u_self', selfUin: '10001' },
    undefined,
    { reuseOutgoing: true },
  ]);
  expect(f.getUnreadInfos.mock.calls[1]).toEqual([target]);
  expect(databasePerformance(path).diagnostics.queries.map((q) => q.priority)).toEqual([
    'background',
    'interactive',
  ]);
  await f.service.dispose();
});

it('同一批统计并发只读取一次，水位快查不等待完整统计，结束后不复用旧快照', async () => {
  const f = fixture('/synthetic/unread-coalesce.db');
  let release!: () => void;
  f.queried.mockImplementationOnce(
    () =>
      new Promise<never[]>((done) => {
        release = () => done([]);
      }),
  );
  const first = f.service.getUnreadInfos(target);
  const second = f.service.getUnreadInfos(target);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(f.getUnreadInfos).toHaveBeenCalledTimes(1);
  // 水位读取不合并到慢速统计。
  const fast = f.service.getUnreadInfos(target, true);
  expect(f.getUnreadInfos).toHaveBeenCalledTimes(2);
  release();
  await Promise.all([first, second, fast]);
  await f.service.getUnreadInfos(target);
  expect(f.getUnreadInfos).toHaveBeenCalledTimes(3);
  await f.service.dispose();
});

it('本地已读领先 QQ 时快查直接确认，完整统计向数据库传递有效下限', async () => {
  const f = fixture('/synthetic/unread-local-floor.db');
  await f.service.markLocalRead(2, '70001', '2');
  const fast = await f.service.getUnreadInfos(target, true);
  expect(fast[0]?.unreadCount).toBe(0);
  expect(fast[0]?.countPending).toBeUndefined();
  await f.service.getUnreadInfos(target);
  expect(f.getUnreadInfos.mock.calls.at(-1)).toEqual([
    target,
    { selfUid: 'u_self', selfUin: '10001' },
    new Map([['2_70001', '2']]),
    { reuseOutgoing: true },
  ]);
  await f.service.dispose();
});

it('合并统计失败后允许重试，不缓存失败或冒充零条未读', async () => {
  const f = fixture('/synthetic/unread-coalesce-failed.db');
  let reject!: (error: Error) => void;
  f.queried.mockImplementationOnce(
    () =>
      new Promise<never[]>((_done, fail) => {
        reject = fail;
      }),
  );
  const first = f.service.getUnreadInfos(target);
  const second = f.service.getUnreadInfos(target);
  const failure = new Error('synthetic read failure');
  const rejected = Promise.all([
    expect(first).rejects.toBe(failure),
    expect(second).rejects.toBe(failure),
  ]);
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  reject(failure);
  await rejected;
  expect(f.getUnreadInfos).toHaveBeenCalledTimes(1);
  expect((await f.service.getUnreadInfos(target))[0]?.unreadCount).toBe(1);
  expect(f.getUnreadInfos).toHaveBeenCalledTimes(2);
  await f.service.dispose();
});

it('账号关闭取消尚未执行的补算，不把取消伪装成零条未读', async () => {
  const path = '/synthetic/unread-dispose.db',
    f = fixture(path);
  let release!: () => void;
  const blocker = scheduleDatabase(
    path,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
    f.binding,
  );
  const read = f.service.getUnreadInfos(target);
  const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
  await f.service.dispose();
  release();
  await Promise.all([blocker, rejected]);
  expect(f.queried).not.toHaveBeenCalled();
  expect((await f.service.getUnreadInfos(target))[0]).toMatchObject({
    readError: true,
    latestSeq: null,
  });
  expect((await f.service.getUnreadInfos(target))[0]?.unreadCount).toBeUndefined();
  expect(f.queried).not.toHaveBeenCalled();
});

it('继承调用方取消，但一个调用取消不影响服务后续读取', async () => {
  const path = '/synthetic/unread-parent-cancel.db',
    f = fixture(path);
  let release!: () => void;
  const blocker = scheduleDatabase(
    path,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
    f.binding,
  );
  const controller = new AbortController();
  const read = withDatabasePriority(
    'interactive',
    () => f.service.getUnreadInfos(target),
    controller.signal,
  );
  const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  release();
  await Promise.all([blocker, rejected]);
  expect(f.signals[0]?.aborted).toBe(true);
  expect((await f.service.getUnreadInfos(target))[0]?.readError).not.toBe(true);
  expect(f.signals[1]?.aborted).toBe(false);
  await f.service.dispose();
});
