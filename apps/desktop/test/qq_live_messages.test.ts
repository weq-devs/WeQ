// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ELEM, encode, MSG_PUSH_ENVELOPE, PIC_COMMON_PB, PTT_COMMON_PB } from '@weqbot/protocol';
import { buildClientReadNotify } from '@weqbot/protocol/qq-sync';
import { MSG_CONTENT } from '../../../vendor/weqbot/packages/protocol/src/msg/schemas';
import {
  FRIEND_RECALL,
  FRIEND_REQUEST,
  GENERAL_GRAY_TIP,
  GROUP_ADMIN,
  GROUP_INVITATION,
  GROUP_INVITE,
  GROUP_JOIN,
  GROUP_MUTE,
  GROUP_NOTIFY_BODY,
  GROUP_REACT,
  INPUT_STATUS_NOTIFY,
  NEW_FRIEND,
} from '../../../vendor/weqbot/packages/protocol/src/push/schemas';
import { mergeRoamingTimeline } from '@weq/service/roaming-timeline';
import { decodeLivePush, LiveMessages } from '../src/main/qq_sync/live_messages';
import { coalesceLiveDbWatch, createLiveMessageObservers } from '../src/main/qq_sync/live_db_watch';
import { createNtMsgDbHook, setProxyMessageReadSharing, type DbWatchTask } from '@weq/service';
import type { AccountSession } from '@weq/account';
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

it('将好友、群和输入状态通知分派给业务层，忽略其他账号及过期的输入状态', () => {
  const notice = (msgType: number, subType: number, msgContent: Uint8Array, at = now) => ({
    contentHead: { msgType, subType, timestamp: at / 1000 },
    body: { msgContent },
  });
  const essence = encode(GROUP_NOTIFY_BODY, {
    groupUin: 70001,
    essenceMessage: { msgSequence: 100, setFlag: 1, timestamp: now / 1000 },
  });
  const wrappedEssence = Buffer.alloc(7 + essence.length);
  wrappedEssence.writeUInt16BE(essence.length, 5);
  wrappedEssence.set(essence, 7);
  const input = (toUid: string) =>
    encode(INPUT_STATUS_NOTIFY, {
      fromUid: 'u_peer',
      toUid,
      notifyItem: { eventType: 3 },
    });
  const friend = (targetUid: string) =>
    encode(FRIEND_REQUEST, {
      info: { targetUid, sourceUid: 'u_new' },
    });
  const result = decodeLivePush(
    body(
      notice(528, 35, friend(self)),
      notice(528, 35, friend('u_other')),
      ...[179, 226].map((subType) =>
        notice(
          528,
          subType,
          encode(NEW_FRIEND, {
            info: { uid: `u_friend${subType}`, toUid: self },
          }),
        ),
      ),
      notice(84, 0, encode(GROUP_JOIN, { groupUin: 70001, targetUid: 'u_peer' })),
      notice(87, 0, encode(GROUP_INVITE, { groupUin: 70002, invitorUid: 'u_peer' })),
      notice(
        525,
        0,
        encode(GROUP_INVITATION, {
          cmd: 87,
          info: { inner: { groupUin: 70003, targetUid: self, invitorUid: 'u_peer' } },
        }),
      ),
      notice(528, 277, input(self)),
      notice(528, 277, input('u_other')),
      notice(528, 277, input(self), now - 7000),
      notice(
        732,
        12,
        encode(GROUP_MUTE, {
          groupUin: 70001,
          data: { state: { targetUid: self, duration: 60 } },
        }),
      ),
      notice(732, 21, wrappedEssence),
      rawGroup,
    ),
    self,
    account,
    now,
  );
  expect(result.updates.business).toEqual([
    { kind: 'friend-request', uid: 'u_new' },
    { kind: 'friend-add', uid: 'u_friend179' },
    { kind: 'friend-add', uid: 'u_friend226' },
    { kind: 'group-request', groupCode: '70001' },
    { kind: 'group-request', groupCode: '70002' },
    { kind: 'group-request', groupCode: '70003' },
    { kind: 'input-status', uid: 'u_peer', speaking: true, expiresAt: now + 6000 },
    { kind: 'group-mute', groupCode: '70001', uid: self, duration: 60, at: now },
    { kind: 'group-essence', groupCode: '70001', sequence: '100', active: true, at: now },
  ]);
  expect(result.rows.map((row) => row.msgSeq)).toEqual(['100']);
});

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
  expect(rows.every((row) => row.livePush === true)).toBe(true);
  expect(rows[0]?.elements).toMatchObject([{ type: 'text', data: { textContent: 'hello' } }]);
});

it('将临时会话、跨端本人消息和私聊文件路由到正确会话', () => {
  const file = encode(MSG_CONTENT, {
    notOnlineFile: {
      fileType: 0,
      subcmd: 1,
      fileName: 'notes.txt',
      fileUuid: 'file-id',
      fileSize: 10n,
    },
  });
  const receipt = encode(MSG_CONTENT, {
    notOnlineFile: {
      fileType: 1,
      subcmd: 2,
      fileName: 'notes.txt',
      fileUuid: 'file-id',
      fileSize: 10n,
    },
  });
  const rows = decodeLivePush(
    body(
      {
        ...rawPrivate,
        contentHead: { ...rawPrivate.contentHead, msgType: 141 },
        responseHead: { ...rawPrivate.responseHead, forward: { tempGroupUin: 70001 } },
      },
      {
        ...rawPrivate,
        contentHead: { ...rawPrivate.contentHead, ntMsgSeq: 111 },
        responseHead: { fromUid: self, fromUin: Number(account), toUid: 'u_peer', toUin: 10002 },
      },
      {
        ...rawPrivate,
        contentHead: {
          ...rawPrivate.contentHead,
          msgType: 529,
          subType: 4,
          c2cCmd: 4,
          ntMsgSeq: 112,
        },
        body: { msgContent: file },
      },
      {
        responseHead: { fromUid: self, fromUin: Number(account), toUid: 'u_peer', toUin: 10002 },
        contentHead: {
          ...rawPrivate.contentHead,
          msgType: 529,
          subType: 4,
          c2cCmd: 4,
          ntMsgSeq: 113,
        },
        body: { msgContent: receipt },
      },
      { ...rawPrivate, responseHead: { ...rawPrivate.responseHead, toUid: 'u_other' } },
    ),
    self,
    account,
    now,
  ).rows;
  expect(rows).toMatchObject([
    {
      kind: 'c2c',
      conv: 'u_peer',
      msgSeq: '110',
      livePeer: { temporary: true, tempSourceGroupCode: '70001' },
    },
    { kind: 'c2c', conv: 'u_peer', msgSeq: '111', senderUid: self },
    {
      kind: 'c2c',
      conv: 'u_peer',
      msgSeq: '112',
      elements: [{ type: 'file', data: { fileName: 'notes.txt' } }],
    },
  ]);
});

it('提前投影引用、多图、表情和可定位语音，缺字段和无法解码的媒体留给落库', () => {
  const reply = {
    replyElement: {
      origMsgSeq: [90],
      origSenderUin: 10001,
      origMsgTime: now / 1000 - 4,
      origElementsRaw: [encode(ELEM, { text: { str: 'original' } })],
    },
  };
  const picture = {
    commonElem: {
      serviceType: 48,
      businessType: 20,
      pbElem: encode(PIC_COMMON_PB, {
        file: {
          body: {
            info: { fileName: 'picture.png', imgWidth: 320, imgHeight: 240 },
            fileToken: 'image-token',
          },
        },
      }),
    },
  };
  const voice = {
    commonElem: {
      serviceType: 48,
      businessType: 12,
      pbElem: encode(PTT_COMMON_PB, {
        file: {
          body: {
            info: { fileName: 'record.amr', pttDuration: 5 },
            fileToken: 'voice-token',
          },
        },
      }),
    },
  };
  const withElems = (raw: typeof rawGroup | typeof rawPrivate, ...elems: unknown[]) => ({
    ...raw,
    body: { richText: { elems } },
  });
  const rows = decodeLivePush(
    body(
      withElems(rawGroup, reply, picture),
      withElems(rawPrivate, voice),
      withElems(rawGroup, { replyElement: { origMsgSeq: [90] } }, picture),
      withElems(rawGroup, picture, picture),
      withElems(rawGroup, picture, { face: { index: 1 } }),
      withElems(rawGroup, { commonElem: { ...picture.commonElem, pbElem: Uint8Array.of(10, 9) } }),
      rawGroup,
    ),
    self,
    account,
    now,
  ).rows;
  expect(rows[0]).toMatchObject({ kind: 'group', msgSeq: '100', ntSeqVerified: true });
  expect(rows.map((row) => row.elements)).toMatchObject([
    [
      {
        type: 'reply',
        data: {
          origMsgSeq: 90,
          origElements: [{ type: 'text', data: { textContent: 'original' } }],
        },
      },
      { type: 'pic', data: { fileToken: 'image-token', imgWidth: 320 } },
    ],
    [
      {
        type: 'ptt',
        data: { fileToken: 'voice-token', pttDuration: 5, waveform: [], livePending: true },
      },
    ],
    [{ type: 'pic' }, { type: 'pic' }],
    [{ type: 'pic' }, { type: 'face' }],
    [{ type: 'text' }],
  ]);
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
  const storedText = [{ kind: 'text', textContent: 'hello' }] as const;
  expect(store.confirm(native, now, storedText)).toEqual({ receivedLive: true, sameText: true });
  expect(store.forConversation('group', '70001', now)).toEqual([]);
  expect(store.accept([row], now)).toEqual([]);
  const dbFirst = new LiveMessages();
  expect(dbFirst.confirm(native, now, storedText)).toEqual({
    receivedLive: false,
    sameText: false,
  });
  expect(dbFirst.accept([row], now)).toEqual([]);
  const changedAtWrite = new LiveMessages();
  changedAtWrite.accept([row], now);
  expect(changedAtWrite.confirm(native, now, [{ kind: 'text', textContent: 'edited' }])).toEqual({
    receivedLive: true,
    sameText: false,
  });
  expect(changedAtWrite.forConversation('group', '70001', now)).toEqual([]);
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

it('有下游消费时桌面同步读取同一观测，保持独立交付且只查一遍消息', async () => {
  vi.useFakeTimers();
  const watches = new Set<DbWatchTask>();
  const coordinator = createLiveMessageObservers({
    mount(task) {
      watches.add(task);
      return {
        unmount: () => {
          watches.delete(task);
          task.dispose?.();
        },
      };
    },
  });
  let latest = 0n;
  const listAfter = vi.fn(async (_group: string, start: bigint) => [
    { msgId: 99n, msgSeq: start + 1n, sendTime: 1n, elements: [] },
  ]);
  const session = {
    msgDbPath: 'nt_msg.db',
    recentContacts: {
      listSeqWatermarks: async () => [
        { targetUid: '70001', chatType: 2, msgSeq: latest, sendTime: 1n },
      ],
    },
    groupMsgs: { listAfter },
  } as unknown as AccountSession;
  setProxyMessageReadSharing(session, () => true);
  let readerEnabled = true;
  const desktop = vi.fn();
  const external = vi.fn();
  const downstream = coordinator
    .consumer(session, () => readerEnabled)
    .mount(createNtMsgDbHook(session, { onDbChanged: () => {}, onNewMessages: external }));
  const primary = coalesceLiveDbWatch(
    createNtMsgDbHook(session, { onDbChanged: () => {}, onNewMessages: desktop }),
    () => !coordinator.hasConsumer(session),
  );
  watches.add(primary);
  try {
    await vi.advanceTimersByTimeAsync(0);
    latest = 1n;
    const change = {
      dbPath: 'nt_msg.db',
      prevTotal: 0,
      total: 1,
      delta: 1,
      files: [],
      at: 1,
      observation: {},
    };
    const read = Promise.all([...watches].map((watch) => watch.onDbFileChangeHook(change)));
    await vi.advanceTimersByTimeAsync(10);
    await read;
    expect(listAfter.mock.calls.map(([group, start]) => [group, start])).toEqual([['70001', 0n]]);
    expect(desktop).toHaveBeenCalledOnce();
    expect(external).toHaveBeenCalledOnce();

    readerEnabled = false;
    expect(coordinator.hasConsumer(session)).toBe(false);
    downstream.unmount();
    expect(coordinator.hasConsumer(session)).toBe(false);
  } finally {
    for (const watch of watches) watch.dispose?.();
    vi.useRealTimers();
  }
});
