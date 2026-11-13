import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { scheduleDatabase, type GroupMsg } from '@weq/db';
import type { NewMessages } from '../src/account/nt_msg_hook';
import type { SsePushPayload } from '../src/account/sse_push';

const state = vi.hoisted(() => ({
  receive: undefined as ((change: NewMessages) => void) | undefined,
  warn: vi.fn(),
}));
vi.mock('../src/common/logger', () => ({
  getLogger: () => ({ child: () => ({ info: vi.fn(), warn: state.warn }) }),
  logErrorContext: () => ({}),
}));
vi.mock('../src/account/db_watch', () => ({
  DbWatchService: class {
    mount() {
      return { unmount: vi.fn() };
    }
  },
}));
vi.mock('../src/account/nt_msg_hook', () => ({
  createNtMsgDbHook: (_session: unknown, hooks: { onNewMessages: typeof state.receive }) => {
    state.receive = hooks.onNewMessages;
    return {};
  },
}));
import { SsePushService } from '../src/account/sse_push';

const services: SsePushService[] = [];
const network = vi.fn<typeof fetch>();
const target = { pushUrl: 'https://push.invalid/a', accessToken: 'synthetic-a' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function message(seq: number, forward = false): GroupMsg {
  return {
    msgId: BigInt(seq),
    msgSeq: BigInt(seq),
    sendTime: 1n,
    senderUid: 'u_fixture',
    senderUin: 20001n,
    targetGroupCode: '123456',
    elements: forward
      ? [{ kind: 'multiMsg', resId: 'synthetic-forward' }]
      : [{ kind: 'text', textContent: `合成消息 ${seq}` }],
  } as unknown as GroupMsg;
}
function fixture(options: { massThreshold?: number; maxPending?: number } = {}) {
  const watermarks = vi.fn(
    async (): Promise<Array<{ targetUid: string; chatType: number; msgSeq: bigint }>> => [],
  );
  const forwards = vi.fn(async (): Promise<[]> => []);
  const latest = vi.fn(async (): Promise<GroupMsg[]> => []);
  const service = new SsePushService(
    {
      context: { uin: 10001n },
      recentContacts: { listSeqWatermarks: watermarks },
      groupMsgs: { listLatest: latest },
      forwardMsgs: { listGroupForward: forwards },
    } as unknown as AccountSession,
    { debounceMs: 10, timeoutMs: 10_000, ...options },
  );
  services.push(service);
  service.start();
  service.setTarget(target);
  return { service, watermarks, forwards, latest };
}
function receive(...rows: GroupMsg[]) {
  state.receive!({
    file: { dbPath: '/fixture/nt_msg.db', prevTotal: 0, total: 1, delta: 1, files: [], at: 1 },
    c2c: [],
    group: rows,
  });
}
const payload = (index: number): SsePushPayload =>
  JSON.parse(network.mock.calls[index]![1]!.body as string);

beforeEach(() => {
  vi.useFakeTimers();
  network.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  state.warn.mockClear();
  vi.stubGlobal('fetch', network);
});
afterEach(async () => {
  for (const service of services.splice(0)) service.stop();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  state.receive = undefined;
});

it.each(['watermarks', 'forward', 'preview'] as const)(
  '停止后不继续 %s 批次的后续查询或 HTTP 发送',
  async (phase) => {
    const f = fixture({ massThreshold: phase === 'preview' ? 1 : 50 });
    const waiting = deferred<[]>();
    if (phase === 'watermarks') f.watermarks.mockImplementationOnce(() => waiting.promise);
    if (phase === 'forward') f.forwards.mockImplementationOnce(() => waiting.promise);
    if (phase === 'preview') f.latest.mockImplementationOnce(() => waiting.promise);
    receive(message(1, phase === 'forward'), message(2, phase === 'forward'));
    await vi.advanceTimersByTimeAsync(10);
    try {
      f.service.stop();
      waiting.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(network).not.toHaveBeenCalled();
      expect(f.forwards).toHaveBeenCalledTimes(phase === 'forward' ? 1 : 0);
      expect(state.warn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      waiting.resolve([]);
    }
  },
);

it('停止立即取消在途 HTTP，迟到失败不重建重试定时器', async () => {
  const f = fixture();
  const waiting = deferred<Response>();
  network.mockImplementationOnce(() => waiting.promise);
  receive(message(1));
  await vi.advanceTimersByTimeAsync(10);
  f.service.stop();
  waiting.reject(new Error('late failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(network.mock.calls[0]![1]!.signal?.aborted).toBe(true);
  expect(state.warn).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('停止时撤销排队的数据库读取，不在其他查询结束后补执行', async () => {
  const f = fixture();
  const binding = {};
  const waiting = deferred<[]>();
  const blocking = scheduleDatabase('/fixture/push.db', () => waiting.promise, binding);
  const read = vi.fn(async () => []);
  f.watermarks.mockImplementationOnce(() => scheduleDatabase('/fixture/push.db', read, binding));
  try {
    receive(message(1));
    await vi.advanceTimersByTimeAsync(10);
    expect(read).not.toHaveBeenCalled();
    f.service.stop();
    waiting.resolve([]);
    await blocking;
    await vi.advanceTimersByTimeAsync(10);
    expect(read).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(state.warn).not.toHaveBeenCalled();
  } finally {
    waiting.resolve([]);
    await blocking;
  }
});

it('停止后快速重启不被旧请求阻塞，旧回执不覆盖新水位', async () => {
  const f = fixture();
  const old = deferred<Response>();
  network.mockImplementationOnce(() => old.promise);
  receive(message(1));
  await vi.advanceTimersByTimeAsync(10);
  f.service.stop();
  f.service.start();
  receive(message(2));
  await vi.advanceTimersByTimeAsync(10);
  try {
    expect(network).toHaveBeenCalledTimes(2);
    expect(payload(1).events.map((event) => event.type === 'message' && event.msgSeq)).toEqual([
      '2',
    ]);
    old.resolve(new Response(null, { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    receive(message(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(network).toHaveBeenCalledTimes(2);
  } finally {
    old.resolve(new Response(null, { status: 200 }));
  }
});

it('切换目标立即取消旧发送并保留待推行，新目标使用新鉴权', async () => {
  const f = fixture();
  const old = deferred<Response>();
  network.mockImplementationOnce(() => old.promise);
  receive(message(1));
  await vi.advanceTimersByTimeAsync(10);
  receive(message(2));
  f.service.setTarget({ pushUrl: 'https://push.invalid/b', accessToken: 'synthetic-b' });
  await vi.advanceTimersByTimeAsync(0);
  try {
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    expect(network.mock.calls[1]![0]).toBe('https://push.invalid/b');
    expect(new Headers(network.mock.calls[1]![1]!.headers).get('Authorization')).toBe(
      'Bearer synthetic-b',
    );
    expect(payload(1).events.map((event) => event.type === 'message' && event.msgSeq)).toEqual([
      '1',
      '2',
    ]);
    old.resolve(new Response(null, { status: 200 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(network).toHaveBeenCalledTimes(2);
  } finally {
    old.resolve(new Response(null, { status: 200 }));
  }
});

it('停用目标不接受新积压，旧请求迟到失败也不恢复重试', async () => {
  const f = fixture();
  const old = deferred<Response>();
  network.mockImplementationOnce(() => old.promise);
  receive(message(1));
  await vi.advanceTimersByTimeAsync(10);
  f.service.setTarget(null);
  receive(message(2));
  old.reject(new Error('late failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  f.service.setTarget(target);
  await vi.advanceTimersByTimeAsync(2000);
  expect(network).toHaveBeenCalledOnce();
});

it('发送期间队列溢出后只消费本批行，不误删尚未发送的新行', async () => {
  const f = fixture({ maxPending: 2 });
  const old = deferred<Response>();
  network.mockImplementationOnce(() => old.promise);
  receive(message(1));
  await vi.advanceTimersByTimeAsync(10);
  receive(message(2), message(3));
  old.resolve(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(20);
  expect(network).toHaveBeenCalledTimes(2);
  expect(payload(1).events.map((event) => event.type === 'message' && event.msgSeq)).toEqual([
    '2',
    '3',
  ]);
  f.service.stop();
});

it('正常失败保留相同事件并按原退避重试，成功后重复序号不再发送', async () => {
  fixture();
  network.mockResolvedValueOnce(new Response(null, { status: 503 }));
  receive(message(1));
  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(999);
  expect(network).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(network).toHaveBeenCalledTimes(2);
  expect(payload(1)).toEqual(payload(0));
  receive(message(1));
  await vi.advanceTimersByTimeAsync(10);
  expect(network).toHaveBeenCalledTimes(2);
});
