import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { GroupMsg } from '@weq/db';
import type { NewMessages } from '../src/account/nt_msg_hook';

const state = vi.hoisted(() => ({
  receive: undefined as ((change: NewMessages) => Promise<void>) | undefined,
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
import { GroupKeywordService, type GroupKeywordHit } from '../src/account/group_keyword';

const services: GroupKeywordService[] = [];
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(onHit: (hit: GroupKeywordHit) => void | Promise<void>) {
  const service = new GroupKeywordService({} as AccountSession, { onHit });
  services.push(service);
  service.setRules({ '123456': { keywords: [{ keyword: '提醒', memberUids: [] }] } });
  service.start();
  return service;
}
function receive(...seqs: number[]) {
  return state.receive!({
    file: { dbPath: '/fixture/nt_msg.db', prevTotal: 0, total: 1, delta: 1, files: [], at: 1 },
    c2c: [],
    group: seqs.map(
      (seq) =>
        ({
          msgSeq: BigInt(seq),
          senderUid: 'u_fixture',
          senderUin: 20001n,
          sendTime: 1n,
          targetGroupCode: '123456',
          elements: [{ kind: 'text', textContent: `提醒 ${seq}` }],
        }) as GroupMsg,
    ),
  });
}
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  state.receive = undefined;
});

it('一页命中逐条交付并向消息 hook 返回背压，不同时展开所有通知', async () => {
  const gate = deferred();
  let active = 0,
    peak = 0;
  const onHit = vi.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await gate.promise;
    active--;
  });
  fixture(onHit);
  const pending = receive(...Array.from({ length: 100 }, (_, index) => index + 1));
  try {
    expect(onHit).toHaveBeenCalledOnce();
    gate.resolve();
    await pending;
    expect(onHit).toHaveBeenCalledTimes(100);
    expect(peak).toBe(1);
  } finally {
    gate.resolve();
  }
});

it('真实通知失败交回消息 hook 重试，成功行去重且失败行可重新交付', async () => {
  let failed = false;
  const onHit = vi.fn(async (hit: GroupKeywordHit) => {
    if (hit.msgSeq === 2n && !failed) {
      failed = true;
      throw new Error('合成通知失败');
    }
  });
  fixture(onHit);
  await expect(receive(1, 2, 3)).rejects.toThrow('合成通知失败');
  expect(onHit.mock.calls.map(([hit]) => hit.msgSeq)).toEqual([1n, 2n]);
  await receive(1, 2, 3);
  expect(onHit.mock.calls.map(([hit]) => hit.msgSeq)).toEqual([1n, 2n, 2n, 3n]);
});

it('停止后不继续本页后续通知，重启可正常处理相同消息', async () => {
  const gate = deferred();
  const onHit = vi.fn<(_: GroupKeywordHit) => Promise<void>>().mockResolvedValue(undefined);
  onHit.mockImplementationOnce(() => gate.promise);
  const service = fixture(onHit);
  const pending = receive(1, 2, 3);
  service.stop();
  gate.resolve();
  await pending;
  expect(onHit).toHaveBeenCalledOnce();
  service.start();
  await receive(1);
  expect(onHit).toHaveBeenCalledTimes(2);
});

it('旧批次迟到失败不删除重启后的去重标记，也不成为未处理拒绝', async () => {
  const old = deferred();
  const onHit = vi.fn<(_: GroupKeywordHit) => Promise<void>>().mockResolvedValue(undefined);
  onHit.mockImplementationOnce(() => old.promise);
  const service = fixture(onHit);
  const pending = receive(1, 2);
  service.stop();
  service.start();
  await receive(1);
  old.reject(new Error('late old generation failure'));
  await pending;
  await receive(1);
  expect(onHit).toHaveBeenCalledTimes(2);
});
