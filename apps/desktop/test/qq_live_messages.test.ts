// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { encode, MSG_PUSH_ENVELOPE } from '@weqbot/protocol';
import { buildClientReadNotify } from '@weqbot/protocol/qq-sync';
import {
  FRIEND_RECALL,
  GENERAL_GRAY_TIP,
  GROUP_ADMIN,
  GROUP_REACT,
} from '../../../vendor/weqbot/packages/protocol/src/push/schemas';
import { mergeRoamingTimeline } from '@weq/service/roaming-timeline';
import { decodeLivePush, LiveMessages } from '../src/main/qq_sync/live_messages';
import { coalesceLiveDbWatch } from '../src/main/qq_sync/live_db_watch';
import { GroupReactionWatch } from '../src/main/qq_sync/group_reaction_watch';

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
  const rows = decodeLivePush(
    body(rawGroup, rawPrivate, unknown, old, other),
    self,
    account,
    now,
  ).rows;
  expect(rows.map((row) => [row.kind, row.conv, row.msgSeq, row.msgRandom])).toEqual([
    ['group', '70001', '100', '7'],
    ['c2c', 'u_peer', '110', '7'],
  ]);
  expect(rows[0]?.elements).toMatchObject([{ type: 'text', data: { textContent: 'hello' } }]);
});

it('普通已读推送只更新收到的账号并保留最高水位', () => {
  const recent = buildClientReadNotify(
    { uin: account, uid: self },
    {
      kind: 'c2c',
      targetUid: 'u_peer',
      sequence: 110,
      timestamp: now / 1000,
    },
  );
  const earlier = buildClientReadNotify(
    { uin: account, uid: self },
    {
      kind: 'c2c',
      targetUid: 'u_peer',
      sequence: 105,
      timestamp: now / 1000,
    },
  );
  const group = buildClientReadNotify(
    { uin: account, uid: self },
    {
      kind: 'group',
      groupUin: 70001,
      sequence: 100,
    },
  );
  expect(
    decodeLivePush(Buffer.concat([recent, earlier, group]), self, account, now).updates.reads,
  ).toEqual([
    { chatType: 1, uid: 'u_peer', sequence: '110' },
    { chatType: 2, uid: '70001', sequence: '100' },
  ]);
  expect(decodeLivePush(recent, 'u_other', '10009', now).updates.reads).toEqual([]);
});

it('只定位涉及的群，重复管理员推送合并为一次资料刷新', () => {
  const change = {
    contentHead: { msgType: 44, timestamp: now / 1000 },
    body: {
      msgContent: encode(GROUP_ADMIN, {
        groupUin: 70001,
        body: { extraEnable: { adminUid: 'u_peer' } },
      }),
    },
  };
  expect(decodeLivePush(body(change, rawGroup, change), self, account, now).updates.groups).toEqual(
    [{ groupCode: '70001', directory: false }],
  );
});

it('代理重放、先入库及晚入库均合并，保留同序号的其他灰条', () => {
  const [row] = decodeLivePush(body(rawGroup), self, account, now).rows;
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

it('表情与撤回推送提供定位，不把包内计数当作完整数据库状态', () => {
  const reaction = encode(GROUP_REACT, {
    groupUin: 70001n,
    field13: 35,
    groupReactionData: {
      data: {
        data: {
          groupReactionTarget: { seq: 100n },
          groupReactionDataContent: { code: '76', operatorUid: 'u_peer', type: 1 },
        },
      },
    },
  });
  const wrapped = Buffer.alloc(reaction.length + 7);
  wrapped.writeUInt16BE(reaction.length, 5);
  Buffer.from(reaction).copy(wrapped, 7);
  const event = decodeLivePush(
    body(
      { contentHead: { msgType: 732, subType: 16 }, body: { msgContent: wrapped } },
      {
        contentHead: { msgType: 528, subType: 138 },
        body: {
          msgContent: encode(FRIEND_RECALL, {
            info: { fromUid: 'u_peer', toUid: self, clientSequence: 4 },
          }),
        },
      },
    ),
    self,
    account,
    now,
  );
  expect(event.updates.reactions).toEqual([{ groupCode: '70001', sequence: 100 }]);
  expect(event.updates.recalled).toBe(true);
  expect(event.updates.interactions).toEqual([{ kind: 'c2c', conv: 'u_peer' }]);
});

it('多端只读一次打开群的表情状态，关闭后取消在途投递', async () => {
  vi.useFakeTimers();
  try {
    const row = { msgId: '5', msgSeq: '100', setEmojiList: undefined };
    const read = vi.fn(async () => [row]);
    const watch = new GroupReactionWatch(read, () => true);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = watch.subscribe('70001', first);
    watch.subscribe('70001', second);
    watch.observe('70002', 3);
    watch.observe('70001', 100);
    watch.observe('70001', 100);
    watch.observe('70001', 101);
    await vi.advanceTimersByTimeAsync(250);
    expect(read.mock.calls).toEqual([['70001', [100n, 101n]]]);
    expect(first.mock.calls).toEqual([[[row]]]);
    expect(second.mock.calls).toEqual([[[row]]]);

    let finish!: (value: [typeof row]) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    watch.observe('70001', 100);
    await vi.advanceTimersByTimeAsync(250);
    watch.clearPending();
    finish([row]);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribe();
  } finally {
    vi.useRealTimers();
  }
});

it('戳一戳只调度戳到当前账号的会话', () => {
  const poke = (toUid: string) => ({
    contentHead: { msgType: 528, subType: 290 },
    body: {
      msgContent: encode(GENERAL_GRAY_TIP, {
        busiType: 12n,
        msgTemplParam: [
          { name: 'uin_str1', value: 'u_peer' },
          { name: 'uin_str2', value: toUid },
        ],
      }),
    },
  });
  const result = decodeLivePush(body(poke(self), poke('u_other'), poke(self)), self, account, now);
  expect(result.updates.interactions).toEqual([{ kind: 'c2c', conv: 'u_peer' }]);
});
