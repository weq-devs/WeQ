// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { AccountQqSync } from '../src/main/qq_sync/account';
import { clientReadTargets } from '@weqbot/protocol/qq-sync';

const f = vi.hoisted(() => ({ request: vi.fn(), history: vi.fn() }));
vi.mock('../src/main/qq_sync/runtime', () => ({ qqSyncRequest: f.request }));
vi.mock('@weqbot/protocol', () => ({
  fetchC2cHistoryRaw: f.history,
  fetchGroupHistoryRaw: f.history,
  extractPath: () => Buffer.from([8, 1]),
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
  let present = false;
  let readState = { msgSeq: 0, localReadSeq: '0', markUnread: false };
  let current = { pid: 123, key: '07'.repeat(16) };
  const row = { msgRandom: 123n, sendTime: 1700000000n, senderUid: 'u_self' };
  const session = {
    context: { uin: '10001' },
    selfUid: 'u_self',
    uidMap: { sortNoByUid: () => 1n },
    unreadInfo: { getUnreadInfo: async () => readState },
    c2cMsgs: { listBySeqsInPartition: async () => (present ? [row] : []) },
  } as unknown as AccountSession;
  const service = new AccountQqSync({
    root,
    path: join(root, 'tasks.json'),
    session,
    nt: {} as NtHelperBinding,
    enabled: () => enabled,
    readEnabled: () => enabled,
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
