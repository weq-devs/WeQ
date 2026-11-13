import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { scheduleDatabase, withDatabasePriority, type GroupMsg } from '@weq/db';
import { createNtMsgDbHook } from '../src/account/nt_msg_hook';
import type { DbChange, DbWatchTask } from '../src/account/db_watch';

const hooks: DbWatchTask[] = [];
const change: DbChange = {
  dbPath: '/fixture/nt_msg.db',
  prevTotal: 0,
  total: 1,
  delta: 1,
  files: [],
  at: 1,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const binding = {};
  let watermark = 0n;
  const readWatermarks = vi.fn(async () => [
    { targetUid: '123456', chatType: 2, msgSeq: watermark, sendTime: 1n },
  ]);
  const listAfter = vi.fn(async (): Promise<GroupMsg[]> => []);
  const boundary = vi.fn(async (): Promise<GroupMsg[]> => []);
  const notify = vi.fn();
  const hook = createNtMsgDbHook(
    {
      msgDbPath: change.dbPath,
      recentContacts: {
        listSeqWatermarks: () => scheduleDatabase(change.dbPath, readWatermarks, binding),
      },
      groupMsgs: { listAfter, listBySeqsInPartition: boundary },
    } as unknown as AccountSession,
    { onDbChanged: () => {}, onNewMessages: notify },
  );
  hooks.push(hook);
  return {
    hook,
    binding,
    readWatermarks,
    listAfter,
    boundary,
    notify,
    setWatermark: (value: bigint) => {
      watermark = value;
    },
  };
}
afterEach(() => {
  for (const hook of hooks.splice(0)) hook.dispose?.();
});

it('启动基线还排队时退出，旧读取不会在阻塞任务结束后执行', async () => {
  const binding = {};
  const gate = deferred<[]>();
  const blocking = scheduleDatabase(change.dbPath, () => gate.promise, binding);
  const read = vi.fn(async () => []);
  const hook = createNtMsgDbHook(
    {
      msgDbPath: change.dbPath,
      recentContacts: { listSeqWatermarks: () => scheduleDatabase(change.dbPath, read, binding) },
    } as unknown as AccountSession,
    { onDbChanged: () => {}, onNewMessages: vi.fn() },
  );
  hooks.push(hook);
  hook.dispose?.();
  gate.resolve([]);
  await blocking;
  await turn();
  await turn();
  expect(read).not.toHaveBeenCalled();
});

it('补充生命周期取消不把调用方的后台读取提升成交互读取', async () => {
  const binding = {};
  const gate = deferred<[]>();
  const order: string[] = [];
  const blocking = scheduleDatabase(change.dbPath, () => gate.promise, binding);
  const hook = withDatabasePriority('background', () =>
    createNtMsgDbHook(
      {
        msgDbPath: change.dbPath,
        recentContacts: {
          listSeqWatermarks: () =>
            scheduleDatabase(
              change.dbPath,
              async () => {
                order.push('baseline');
                return [];
              },
              binding,
            ),
        },
      } as unknown as AccountSession,
      { onDbChanged: () => {}, onNewMessages: vi.fn() },
    ),
  );
  hooks.push(hook);
  const foreground = scheduleDatabase(
    change.dbPath,
    async () => {
      order.push('foreground');
      return [];
    },
    binding,
  );
  gate.resolve([]);
  await blocking;
  await foreground;
  await turn();
  await turn();
  expect(order).toEqual(['foreground', 'baseline']);
});

it('补充生命周期取消后仍响应调用方已有的取消信号', async () => {
  const binding = {};
  const gate = deferred<[]>();
  const parent = new AbortController();
  const blocking = scheduleDatabase(change.dbPath, () => gate.promise, binding);
  const read = vi.fn(async () => []);
  const hook = withDatabasePriority(
    'background',
    () =>
      createNtMsgDbHook(
        {
          msgDbPath: change.dbPath,
          recentContacts: {
            listSeqWatermarks: () => scheduleDatabase(change.dbPath, read, binding),
          },
        } as unknown as AccountSession,
        { onDbChanged: () => {}, onNewMessages: vi.fn() },
      ),
    parent.signal,
  );
  hooks.push(hook);
  parent.abort();
  gate.resolve([]);
  await blocking;
  await turn();
  await turn();
  expect(read).not.toHaveBeenCalled();
});

it('补齐水位还排队时退出，不在之后补执行，也不交付旧消息', async () => {
  const f = fixture();
  await f.hook.onDbFileChangeHook(change);
  const before = f.readWatermarks.mock.calls.length;
  const gate = deferred<[]>();
  const blocking = scheduleDatabase(change.dbPath, () => gate.promise, f.binding);
  f.setWatermark(1n);
  const pending = f.hook.onDbFileChangeHook(change);
  await turn();
  f.hook.dispose?.();
  gate.resolve([]);
  await blocking;
  await pending;
  expect(f.readWatermarks).toHaveBeenCalledTimes(before);
  expect(f.listAfter).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalled();
});

it('整页读取途中退出，返回后不继续同序号边界补查和后续交付', async () => {
  const f = fixture();
  await f.hook.onDbFileChangeHook(change);
  const gate = deferred<GroupMsg[]>();
  f.listAfter.mockImplementationOnce(() => gate.promise);
  f.setWatermark(500n);
  const pending = f.hook.onDbFileChangeHook(change);
  await turn();
  expect(f.listAfter).toHaveBeenCalledOnce();
  f.hook.dispose?.();
  gate.resolve(
    Array.from(
      { length: 500 },
      (_, index) =>
        ({
          msgSeq: BigInt(index + 1),
          msgId: BigInt(index + 1),
          sendTime: 1n,
        }) as GroupMsg,
    ),
  );
  await pending;
  expect(f.boundary).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalled();
});
