import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import {
  databaseRequestSignal,
  scheduleDatabase,
  withDatabasePriority,
  type GroupMsg,
} from '@weq/db';
import { createNtMsgDbHook, setProxyMessageReadSharing } from '../src/account/nt_msg_hook';
import { toObservedRenderElements } from '../src/account/msg_view';
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

it('同账号同轮共用水位，退出一个监听器保留其他读取，下轮重新查询', async () => {
  const watermarks = (msgSeq: bigint) => [
    { targetUid: '123456', chatType: 2, msgSeq, sendTime: 1n },
  ];
  const read = vi.fn(async () => watermarks(0n));
  const listAfter = vi.fn(async (_uid: string, cursor: bigint) => [
    { msgId: cursor + 1n, msgSeq: cursor + 1n, sendTime: 1n } as GroupMsg,
  ]);
  const session = {
    msgDbPath: change.dbPath,
    recentContacts: { listSeqWatermarks: read },
    groupMsgs: { listAfter },
  } as unknown as AccountSession;
  const a = vi.fn();
  const b = vi.fn();
  const first = createNtMsgDbHook(session, { onDbChanged: () => {}, onNewMessages: a });
  const second = createNtMsgDbHook(session, { onDbChanged: () => {}, onNewMessages: b });
  hooks.push(first, second);
  await turn();
  read.mockClear();
  const gate = deferred<ReturnType<typeof watermarks>>();
  let sharedSignal: AbortSignal | undefined;
  read.mockImplementationOnce(() => {
    sharedSignal = databaseRequestSignal();
    return gate.promise;
  });
  const observation = {};
  const pending = [
    first.onDbFileChangeHook({ ...change, observation }),
    second.onDbFileChangeHook({ ...change, observation }),
  ];
  await turn();
  expect(read).toHaveBeenCalledOnce();
  first.dispose?.();
  expect(sharedSignal?.aborted).toBe(false);
  gate.resolve(watermarks(1n));
  await Promise.all(pending);
  expect(a).not.toHaveBeenCalled();
  expect(b).toHaveBeenCalledWith(
    expect.objectContaining({ group: [{ msgId: 1n, msgSeq: 1n, sendTime: 1n }] }),
  );

  read.mockResolvedValueOnce(watermarks(2n));
  await second.onDbFileChangeHook({ ...change, observation: {} });
  expect(read).toHaveBeenCalledTimes(2);
  expect(b).toHaveBeenCalledTimes(2);
});

it('代理优化开启时同一观测只读一页正文，关闭后各订阅仍独立交付', async () => {
  let seq = 0n;
  let enabled = true;
  const listAfter = vi.fn(async (_uid: string, cursor: bigint) => [
    {
      msgId: cursor + 1n,
      msgSeq: cursor + 1n,
      sendTime: 1n,
      elements: [{ kind: 'text', textContent: 'a' }],
    } as GroupMsg,
  ]);
  const session = {
    msgDbPath: change.dbPath,
    recentContacts: {
      listSeqWatermarks: async () => [
        { targetUid: '123456', chatType: 2, msgSeq: seq, sendTime: 1n },
      ],
    },
    groupMsgs: { listAfter },
  } as unknown as AccountSession;
  setProxyMessageReadSharing(session, () => enabled);
  const subscribers = Array.from({ length: 4 }, () => {
    const notify = vi.fn();
    const hook = createNtMsgDbHook(session, { onDbChanged: () => {}, onNewMessages: notify });
    hooks.push(hook);
    return { hook, notify };
  });
  await turn();
  const publish = () => {
    const event = { ...change, observation: {} };
    return Promise.all(subscribers.map(({ hook }) => hook.onDbFileChangeHook(event)));
  };
  seq = 1n;
  await publish();
  expect(listAfter).toHaveBeenCalledOnce();
  for (const { notify } of subscribers) expect(notify).toHaveBeenCalledOnce();
  const conversions = subscribers.map(({ notify }) =>
    toObservedRenderElements(notify.mock.calls[0]![0].group[0].elements),
  );
  expect(conversions.slice(1).every((value) => value === conversions[0])).toBe(true);
  enabled = false;
  seq = 2n;
  await publish();
  expect(listAfter).toHaveBeenCalledTimes(5);
  for (const { notify } of subscribers) expect(notify).toHaveBeenCalledTimes(2);
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
