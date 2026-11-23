// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { encode, MSG_PUSH_ENVELOPE } from '@weqbot/protocol';
import { mergeRoamingTimeline } from '@weq/service/roaming-timeline';
import { decodeLiveMessages, LiveMessages } from '../src/main/qq_sync/live_messages';
import { coalesceLiveDbWatch } from '../src/main/qq_sync/live_db_watch';

const now = 1_800_000_000_000;
const account = '10001';
const self = 'u_self';
const rawGroup = {
  contentHead: { msgType: 82, sequence: 100, timestamp: now / 1000, msgId: 7 },
  responseHead: { fromUid: 'u_peer', fromUin: 10002, grp: { groupUin: 70001 } },
  body: { richText: { elems: [{ text: { str: 'hello' } }] } },
};
const rawPrivate = {
  ...rawGroup,
  contentHead: { ...rawGroup.contentHead, msgType: 166, sequence: 5, ntMsgSeq: 110 },
  responseHead: { fromUid: 'u_peer', fromUin: 10002, toUid: self, toUin: Number(account) },
};
const body = (...messages: unknown[]) => encode(MSG_PUSH_ENVELOPE, { messages });

it('只接收当前账号的实时普通文本，私聊采用 NT 会话序号', () => {
  const unknown = { ...rawPrivate, contentHead: { ...rawPrivate.contentHead, c2cCmd: 73 } };
  const old = { ...rawGroup, contentHead: { ...rawGroup.contentHead, timestamp: now / 1000 - 31 } };
  const other = { ...rawPrivate, responseHead: { ...rawPrivate.responseHead, toUid: 'u_other' } };
  const rows = decodeLiveMessages(
    body(rawGroup, rawPrivate, unknown, old, other),
    self,
    account,
    now,
  );
  expect(rows.map((row) => [row.kind, row.conv, row.msgSeq, row.msgRandom])).toEqual([
    ['group', '70001', '100', '7'],
    ['c2c', 'u_peer', '110', '7'],
  ]);
  expect(rows[0]?.elements).toMatchObject([{ type: 'text', data: { textContent: 'hello' } }]);
});

it('代理重放、先入库及晚入库均合并，保留同序号的其他灰条', () => {
  const [row] = decodeLiveMessages(body(rawGroup), self, account, now);
  if (!row) throw Error('fixture did not decode');
  const native = { ...row, sourceFormat: undefined, msgId: '12345' };
  const other = { ...native, msgRandom: '0', msgId: '90000' };
  const store = new LiveMessages();
  expect(store.accept([row, row], now)).toEqual([row]);
  expect(
    mergeRoamingTimeline('group', [native, other], store.forConversation('group', '70001', now)),
  ).toEqual([native, other]);
  store.confirm(native, now);
  expect(store.forConversation('group', '70001', now)).toEqual([]);
  expect(store.accept([row], now)).toEqual([]);
  const dbFirst = new LiveMessages();
  dbFirst.confirm(native, now);
  expect(dbFirst.accept([row], now)).toEqual([]);
});

it('代理活跃时合并读库，持续写入也在固定时间内校准未知变化', async () => {
  vi.useFakeTimers();
  try {
    let havePush = true;
    const read = vi.fn();
    const watch = coalesceLiveDbWatch(
      { dbPath: 'nt_msg.db', onDbFileChangeHook: read },
      () => havePush,
    );
    const file = (at: number) => ({
      dbPath: 'nt_msg.db',
      at,
      prevTotal: 0,
      total: 0,
      delta: 0,
      files: [],
    });
    watch.onDbFileChangeHook(file(1));
    await vi.advanceTimersByTimeAsync(500);
    watch.onDbFileChangeHook(file(2));
    await vi.advanceTimersByTimeAsync(500);
    watch.onDbFileChangeHook(file(3));
    await vi.advanceTimersByTimeAsync(200);
    expect(read.mock.calls.map(([change]) => change.at)).toEqual([3]);
    havePush = false;
    watch.onDbFileChangeHook(file(4));
    expect(read.mock.calls.map(([change]) => change.at)).toEqual([3, 4]);
    watch.dispose?.();
  } finally {
    vi.useRealTimers();
  }
});
