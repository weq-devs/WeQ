// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { AccountQqSync } from '../src/main/qq_sync/account';
import { clientReadTargets } from '@weqbot/protocol/qq-sync';
import { encode, FRIEND_RECALL, INPUT_STATUS_NOTIFY, MSG_PUSH_ENVELOPE } from '@weqbot/protocol';
import type { AntiRecallService } from '@weq/service';

const f = vi.hoisted(() => ({ request: vi.fn(), history: vi.fn(), subscribe: vi.fn() }));
vi.mock('../src/main/qq_sync/runtime', () => ({
  qqSyncRequest: f.request,
  subscribeQqLive: f.subscribe,
}));
vi.mock('@weqbot/protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weqbot/protocol')>()),
  fetchC2cHistoryRaw: f.history,
  fetchGroupHistoryRaw: f.history,
  extractPath: () => Buffer.from([8, 1]),
  readReportWatermark: (target: { kind: string; sequence: number; timestamp?: number }) =>
    target.kind === 'official' ? target.timestamp : target.sequence,
}));
const directories: string[] = [];
const services: AccountQqSync[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});
function fixture(path?: string) {
  const root = path ?? mkdtempSync(join(tmpdir(), 'weq-qq-sync-'));
  if (!path) directories.push(root);
  let online = false;
  let enabled = true;
  let proxyEnabled = true;
  let present = false;
  let readState = { msgSeq: 0, localReadSeq: '0', markUnread: false };
  let current = { pid: 123, key: '07'.repeat(16) };
  const row = { msgRandom: 123n, sendTime: 1700000000n, senderUid: 'u_self' };
  const reads = vi.fn(async () => (present ? [row] : []));
  const session = {
    context: { uin: '10001' },
    selfUid: 'u_self',
    uidMap: { sortNoByUid: () => 1n },
    unreadInfo: { getUnreadInfo: async () => readState },
    c2cMsgs: { listBySeqsInPartition: reads },
  } as unknown as AccountSession;
  const service = new AccountQqSync({
    root,
    path: join(root, 'tasks.json'),
    session,
    nt: {} as NtHelperBinding,
    proxyEnabled: () => proxyEnabled,
    enabled: () => enabled,
    current: () => (online ? current : null),
  });
  services.push(service);
  f.request.mockResolvedValue({ delivered: true });
  f.history.mockResolvedValue({
    peer: { friendUid: 'u_peer' },
    rawResponse: Buffer.alloc(1),
    messages: [
      { responseHead: { fromUid: 'u_self' }, contentHead: { msgId: 123, timestamp: 1700000000 } },
    ],
  });
  return {
    service,
    root,
    reads,
    setReadState: (value: typeof readState) => {
      readState = value;
    },
    setOnline: () => {
      online = true;
      service.refresh();
    },
    setPresent: (sendTime = 1700000000n) => {
      present = true;
      row.sendTime = sendTime;
    },
    disable: () => {
      enabled = false;
    },
    setProxyEnabled: (value: boolean) => {
      proxyEnabled = value;
      service.refreshLive();
    },
    changeSession: () => {
      current = { pid: 456, key: '08'.repeat(16) };
    },
    saved: () => JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')),
  };
}
const sent = {
  kind: 'c2c',
  conv: 'u_peer',
  msgSeq: '90',
  msgRandom: '123',
  msgId: '123',
  senderUid: 'u_self',
  senderUin: '10001',
  sendTime: '1700000000',
  elements: [],
} as const;
it('代理关闭时保留待同步任务，重新开启后接续已有任务', async () => {
  const state = fixture();
  state.service.read({ kind: 'group', groupUin: 55555, sequence: 10 });
  await vi.waitFor(() => expect(state.saved().tasks).toHaveLength(1));
  state.setProxyEnabled(false);
  state.setOnline();
  state.service.read({ kind: 'group', groupUin: 55555, sequence: 20 });
  expect(state.service.status().pending).toBe(1);
  expect(f.request).not.toHaveBeenCalled();

  await Promise.resolve();
  state.setProxyEnabled(true);
  await vi.waitFor(() => expect(state.service.status().completed).toBe(1));
  const push = f.request.mock.calls.find(([, request]) => request.op === 'push');
  expect(clientReadTargets(Buffer.from(push?.[1].body, 'base64'))).toEqual([
    { kind: 'group', groupUin: 55555, sequence: 10 },
  ]);
});

it('同一会话待补读水位合并到最高位置', async () => {
  const state = fixture();
  state.service.read({ kind: 'group', groupUin: 55555, sequence: 10 });
  state.service.read({ kind: 'group', groupUin: 55555, sequence: 20 });
  state.service.read({ kind: 'group', groupUin: 55555, sequence: 15 });
  await vi.waitFor(() => expect(state.saved().tasks[0]?.target.sequence).toBe(20));
  state.setOnline();
  await vi.waitFor(() => expect(state.service.status().completed).toBe(1));
  const pushes = f.request.mock.calls.filter((call) => call[1].op === 'push');
  expect(pushes).toHaveLength(1);
  expect(clientReadTargets(Buffer.from(pushes[0]![1].body, 'base64'))).toEqual([
    { kind: 'group', groupUin: 55555, sequence: 20 },
  ]);
});
it.each([false, true])('公众号零序号按时间合并，后续手动未读（%s）使补投失效', async (unread) => {
  const state = fixture();
  const key = 'official:u_peer';
  const reads = { [key]: '0:1700000002:20', ...(unread ? { [`unread:${key}`]: '9' } : {}) };
  writeFileSync(join(state.root, 'client-state.json'), JSON.stringify({ records: { reads } }));
  for (const timestamp of [1700000001, 1700000002, 1700000000])
    state.service.read({ kind: 'official', targetUid: 'u_peer', sequence: 0, timestamp });
  await vi.waitFor(() => expect(state.saved().tasks[0]?.target.timestamp).toBe(1700000002));
  state.setOnline();
  await vi.waitFor(() => expect(state.service.status().pending).toBe(0));
  const pushes = f.request.mock.calls.filter((call) => call[1].op === 'push');
  expect(pushes).toHaveLength(unread ? 0 : 1);
  if (!unread) {
    expect(pushes[0]![1].identity).toBe('read:official:u_peer:1700000002');
    expect(clientReadTargets(Buffer.from(pushes[0]![1].body, 'base64'))).toEqual([
      { kind: 'official', targetUid: 'u_peer', sequence: 0, timestamp: 1700000002 },
    ]);
  }
});
it('重启恢复先查本地接纳，已有消息不重复补投', async () => {
  const original = fixture();
  original.service.sent({ ...sent, elements: [] });
  await vi.waitFor(() => expect(original.saved().tasks).toHaveLength(1));
  await original.service.dispose();
  const restored = fixture(original.root);
  restored.setPresent();
  restored.setOnline();
  await new Promise((resolve) => setTimeout(resolve, 750));
  restored.service.refresh();
  await vi.waitFor(() => expect(restored.service.status().pending).toBe(0));
  expect(f.request.mock.calls.filter((call) => call[1].op === 'push')).toHaveLength(0);
  expect(f.history).not.toHaveBeenCalled();
});
it('回执与服务器时间相差一秒时按消息身份补投，并确认不同时间的入库记录', async () => {
  const state = fixture();
  f.history.mockResolvedValue({
    peer: { friendUid: 'u_peer' },
    rawResponse: Buffer.alloc(1),
    messages: [
      { responseHead: { fromUid: 'u_self' }, contentHead: { msgId: 123, timestamp: 1699999999 } },
    ],
  });
  f.request.mockImplementation(async (_root, request) => {
    if (request.op === 'push') state.setPresent(1699999999n);
    return { delivered: true };
  });
  state.service.sent({ ...sent, elements: [] });
  await vi.waitFor(() => expect(state.saved().tasks).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 750));
  state.setOnline();
  await vi.waitFor(() => expect(state.service.status().pending).toBe(0));
  expect(state.service.status().completed).toBe(1);
  expect(f.request.mock.calls.filter((call) => call[1].op === 'push')).toHaveLength(1);
});
it('已有落库观察确认本人补投时，不等固定延时再读一次库', async () => {
  const state = fixture();
  f.request.mockImplementation(async (_root, request) => {
    if (request.op === 'push') {
      state.service.observeStoredMessage('c2c', sent.conv, BigInt(sent.msgSeq), 123n, 'u_other');
      state.service.observeStoredMessage('c2c', sent.conv, BigInt(sent.msgSeq), 124n, 'u_self');
      expect(state.service.status().pending).toBe(1);
      state.service.observeStoredMessage('c2c', sent.conv, BigInt(sent.msgSeq), 123n, 'u_self');
    }
    return { delivered: true };
  });
  state.service.sent({ ...sent, elements: [] });
  await vi.waitFor(() => expect(state.saved().tasks).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 750));
  state.setOnline();
  await vi.waitFor(() => expect(state.service.status().completed).toBe(1));
  expect(state.reads).toHaveBeenCalledOnce();
});

it('旧连接迟到的已读补投回执不清掉当前仍待确认的任务', async () => {
  const state = fixture();
  let finish!: (value: { delivered: boolean }) => void;
  f.request.mockImplementation(async (_root, request) => {
    if (request.op === 'push')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { delivered: true };
  });
  state.service.read({ kind: 'group', groupUin: 55555, sequence: 20 });
  await vi.waitFor(() => expect(state.saved().tasks).toHaveLength(1));
  state.setOnline();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  state.changeSession();
  finish({ delivered: true });
  await new Promise((resolve) => setImmediate(resolve));
  expect(state.service.status()).toMatchObject({ pending: 1, completed: 0 });
});
it.each([
  { fromUid: 'u_other', msgId: 123 },
  { fromUid: 'u_self', msgId: 456 },
])('拒绝发送者或消息随机数不匹配的历史记录', async (identity) => {
  const state = fixture();
  f.history.mockResolvedValue({
    peer: { friendUid: 'u_peer' },
    rawResponse: Buffer.alloc(1),
    messages: [
      {
        responseHead: { fromUid: identity.fromUid },
        contentHead: { msgId: identity.msgId, timestamp: 1699999999 },
      },
    ],
  });
  state.service.sent({ ...sent, elements: [] });
  await vi.waitFor(() => expect(state.saved().tasks).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 750));
  state.setOnline();
  await vi.waitFor(() => expect(state.service.status().error).toBe('等待服务器确认原始消息'));
  expect(state.service.status().pending).toBe(1);
  expect(f.request.mock.calls.filter((call) => call[1].op === 'push')).toHaveLength(0);
});
it('历史请求期间会话变化时停止旧会话补投', async () => {
  const state = fixture();
  let finish: (value: unknown) => void = () => {};
  f.history.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  state.service.sent({ ...sent, elements: [] });
  await vi.waitFor(() => expect(state.saved().tasks).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 750));
  state.setOnline();
  await vi.waitFor(() => expect(f.history).toHaveBeenCalledOnce());
  state.changeSession();
  finish({
    peer: { friendUid: 'u_peer' },
    rawResponse: Buffer.alloc(1),
    messages: [
      { responseHead: { fromUid: 'u_self' }, contentHead: { msgId: 123, timestamp: 1700000000 } },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.request.mock.calls.filter((call) => call[1].op === 'push')).toHaveLength(0);
  expect(state.service.status().pending).toBe(1);
});

it.each([
  { msgSeq: 30, localReadSeq: '30', markUnread: false },
  { msgSeq: 20, localReadSeq: '20', markUnread: true },
])('后续阅读或手动未读覆盖旧的待同步水位', async (state) => {
  const fxt = fixture();
  fxt.service.read({ kind: 'group', groupUin: 55555, sequence: 20 });
  await vi.waitFor(() => expect(fxt.saved().tasks).toHaveLength(1));
  fxt.setReadState(state);
  fxt.setOnline();
  await vi.waitFor(() => expect(fxt.service.status().pending).toBe(0));
  expect(f.request.mock.calls.filter((call) => call[1].op === 'push')).toHaveLength(0);
});

it('实时撤回唤醒持久队列，空闲时保留低频校准', async () => {
  vi.useFakeTimers();
  try {
    const root = mkdtempSync(join(tmpdir(), 'weq-recall-stream-'));
    directories.push(root);
    let enabled = true;
    const observePush = vi.fn(async () => {});
    const onLiveUpdates = vi.fn();
    const entry = { id: 'notice', at: Date.now(), events: [] };
    const session = { context: { uin: '10001' }, selfUid: 'u_self' } as unknown as AccountSession;
    const protection = () => ({ enabled: true, method: 'proxy', mode: 'all', targets: [] });
    const antiRecall = {
      protection,
      archive: { observePush },
      setProxyState: vi.fn(),
    } as unknown as AntiRecallService;
    let pending = false;
    f.request.mockImplementation(async (_root, request) => {
      if (request.op === 'status') return { protocolVersion: 4, accounts: ['10001'] };
      if (request.op === 'recall-events') return pending ? [entry] : [];
      return true;
    });
    let deliver!: (body: Buffer) => void;
    f.subscribe.mockImplementation((_root, _uin, _generation, signal: AbortSignal, callback) => {
      deliver = callback;
      return new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    const service = new AccountQqSync({
      root,
      path: join(root, 'tasks.json'),
      session,
      antiRecall,
      nt: {} as NtHelperBinding,
      proxyEnabled: () => true,
      enabled: () => false,
      liveEnabled: () => enabled,
      onLiveMessages: () => {},
      onLiveUpdates,
      current: () => ({ pid: 123, key: '07'.repeat(16) }),
    });
    services.push(service);
    const polls = () =>
      f.request.mock.calls.filter(([, request]) => request.op === 'recall-events');
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(polls()).toHaveLength(1);
    pending = true;
    deliver(
      Buffer.from(
        encode(MSG_PUSH_ENVELOPE, {
          messages: [
            {
              contentHead: { msgType: 528, subType: 138 },
              body: {
                msgContent: encode(FRIEND_RECALL, {
                  info: { fromUid: 'u_peer', toUid: 'u_self', clientSequence: 4 },
                }),
              },
            },
          ],
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(120);
    expect(polls()).toHaveLength(2);
    expect(observePush).toHaveBeenCalledWith(entry.events, 'u_self', entry.at);
    expect(service.status().live).toMatchObject({
      enabled: true,
      receivedFrames: 1,
      acceptedMessages: 0,
      recallFrames: 1,
      interactionTargets: 1,
    });
    deliver(
      Buffer.from(
        encode(MSG_PUSH_ENVELOPE, {
          messages: [
            {
              contentHead: { msgType: 528, subType: 277 },
              body: {
                msgContent: encode(INPUT_STATUS_NOTIFY, {
                  fromUid: 'u_peer',
                  toUid: 'u_self',
                  notifyItem: { eventType: 1 },
                }),
              },
            },
          ],
        }),
      ),
    );
    expect(onLiveUpdates).toHaveBeenLastCalledWith(
      expect.objectContaining({
        business: [expect.objectContaining({ kind: 'input-status', uid: 'u_peer' })],
      }),
    );
    pending = false;
    enabled = false;
    service.refreshLive();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls().at(-1)?.[1].ack).toEqual(['notice']);
    expect(service.status().live.enabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
