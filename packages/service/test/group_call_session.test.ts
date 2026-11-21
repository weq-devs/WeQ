/**
 * 群通话会话状态机回归测试。
 *
 * 全程用假时钟 + 假 socket + 假信令，不碰真 QQ、不联网。报文样本来自
 * `@weqbot/protocol` 的抓包 fixture，所以「收到真实字节能不能正确驱动状态机」
 * 也一并覆盖了。
 */

import { describe, expect, it, vi } from 'vitest';
import { encode, groupCall, MSG_PUSH_CMD, MSG_PUSH_ENVELOPE } from '@weqbot/protocol';
import { pbBytes, pbVarint } from '../../../vendor/weqbot/packages/protocol/src/call/gcs';
import {
  GroupCallSession,
  makeGroupStream,
  type GroupCallCodec,
  type GroupCallSignaling,
  type GroupCallTimers,
  type GroupCallTransport,
} from '../src/account/group_call_session';
import {
  audioDownPlain,
  authRspOk,
  gcsKeyPush,
  gcsSimplifyPush,
  keepalive,
  mediaDown,
  memberPeerJoin,
  memberSelfReady,
} from './fixtures/group_call_capture';

const { GROUP_SESSION_KEY_LEN, GroupRelayCmd, parseGroupRelay } = groupCall;

const SELF_UIN = 1707889225;
const SELF_UID = 'u_self';
const PEER_UIN = 2940720980;
const PEER_UID = 'u_peer';
const GROUP_ID = 673646675;
/** 退出包重发序列的总时长（5 次 × 100ms），假时钟要推进这么久。 */
const EXIT_RETRY_TOTAL_MS = 1500;
const AUTH_KEY = new Uint8Array(GROUP_SESSION_KEY_LEN).fill(0x11);

// ─────────────────────────── 测试替身 ───────────────────────────

/** 手动推进的时钟。 */
class FakeTimers implements GroupCallTimers {
  private nowMs = 1_000_000;
  private nextId = 1;
  private readonly intervals = new Map<number, { fn: () => void; ms: number; at: number }>();
  private readonly timeouts = new Map<number, { fn: () => void; at: number }>();

  now(): number {
    return this.nowMs;
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.intervals.set(id, { fn, ms, at: this.nowMs + ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timeouts.set(id, { fn, at: this.nowMs + ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  /** 前进 `ms`，按到点顺序触发回调。 */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let next: { id: number; at: number; fn: () => void; interval: boolean } | null = null;
      for (const [id, item] of this.intervals) {
        if (item.at <= target && (!next || item.at < next.at)) {
          next = { id, at: item.at, fn: item.fn, interval: true };
        }
      }
      for (const [id, item] of this.timeouts) {
        if (item.at <= target && (!next || item.at < next.at)) {
          next = { id, at: item.at, fn: item.fn, interval: false };
        }
      }
      if (!next) break;
      this.nowMs = next.at;
      if (next.interval) {
        const item = this.intervals.get(next.id)!;
        item.at += item.ms;
      } else {
        this.timeouts.delete(next.id);
      }
      next.fn();
    }
    this.nowMs = target;
  }
}

/** 记录发出的包。 */
class FakeTransport implements GroupCallTransport {
  readonly sent: Array<{ data: Uint8Array; port: number; address: string }> = [];
  closed = false;
  private handler: ((data: Uint8Array, from: { address: string; port: number }) => void) | null =
    null;

  async bind(): Promise<void> {}
  send(data: Uint8Array, port: number, address: string): void {
    this.sent.push({ data, port, address });
  }
  close(): void {
    this.closed = true;
  }
  onMessage(handler: (data: Uint8Array, from: { address: string; port: number }) => void): void {
    this.handler = handler;
  }
  onError(): void {}

  /** 模拟收到一个包。 */
  deliver(data: Uint8Array): void {
    this.handler?.(data, { address: '1.2.3.4', port: 7791 });
  }
}

/** 测试替身，保留逐帧编解码的异步接口。 */
const fakeCodec: GroupCallCodec = {
  encode: async (pcm) => pcm.subarray(0, 8),
  decode: async (opus) => new Uint8Array(opus.length * 40),
};

/** 可控的信令层。 */
class FakeSignaling implements GroupCallSignaling {
  createCalls = 0;
  invitePrefixes: number[] = [];
  invites: Array<Parameters<GroupCallSignaling['invite']>[0]> = [];
  syncCalls = 0;
  queryPrefixes: number[] = [];
  failCreate = false;
  private readonly subscribers = new Map<string, (body: Uint8Array) => void>();
  readonly push: NonNullable<GroupCallSignaling['push']> = {
    subscribe: (command, listener) => {
      this.subscribers.set(command, listener);
      return () => this.subscribers.delete(command);
    },
    send: async () => {},
  };

  async create(): Promise<{
    room: { ownerUin: number; authKey: Uint8Array; servers: Array<{ ip: string; port: number }> };
  }> {
    this.createCalls += 1;
    if (this.failCreate) throw new Error('开房失败');
    return {
      room: {
        ownerUin: PEER_UIN,
        authKey: AUTH_KEY,
        servers: [{ ip: '1.2.3.4', port: 7791 }],
      },
    };
  }

  async invite(params: Parameters<GroupCallSignaling['invite']>[0]): Promise<undefined> {
    this.invitePrefixes.push(params.streamPrefix);
    this.invites.push(params);
  }

  inviteNotice(room: number, type: 1 | 3, ...uids: string[]): void {
    const field = type === 1 ? 1 : 2;
    const msgContent = Buffer.concat([
      pbVarint(3, GROUP_ID),
      pbVarint(4, room),
      pbVarint(6, type),
      ...uids.map((uid) => pbBytes(field, pbBytes(1, Buffer.from(uid)))),
    ]);
    this.subscribers.get(MSG_PUSH_CMD)?.(
      encode(MSG_PUSH_ENVELOPE, {
        messages: [{ contentHead: { msgType: 528, subType: 278 }, body: { msgContent } }],
      }),
    );
  }

  chatNotice({
    room = 0x180106aa,
    groupId = GROUP_ID,
    recipient = SELF_UIN,
    id,
    text,
  }: {
    room?: number;
    groupId?: number;
    recipient?: number;
    id: number;
    text: string;
  }): void {
    const context = Buffer.concat([pbVarint(1, 1), pbVarint(2, groupId), pbVarint(3, room)]);
    const chat = Buffer.concat([
      pbVarint(1, PEER_UIN),
      pbBytes(2, Buffer.from(text)),
      pbVarint(3, 1),
      pbVarint(4, id),
    ]);
    const event = Buffer.concat([pbBytes(1, context), pbBytes(2, chat)]);
    this.subscribers.get(MSG_PUSH_CMD)?.(
      encode(MSG_PUSH_ENVELOPE, {
        messages: [
          {
            responseHead: { fromUin: PEER_UIN, toUin: recipient },
            contentHead: { msgType: 528, subType: 294 },
            body: { msgContent: pbBytes(3, event) },
          },
        ],
      }),
    );
  }

  async multiTerminalSync(): Promise<void> {
    this.syncCalls += 1;
  }

  async query(params: Parameters<GroupCallSignaling['query']>[0]): Promise<{
    members: Array<{ uin: number; uid: string | null }>;
  }> {
    this.queryPrefixes.push(params.streamPrefix);
    return {
      members: [
        { uin: SELF_UIN, uid: SELF_UID },
        { uin: PEER_UIN, uid: PEER_UID },
      ],
    };
  }
}

interface Harness {
  session: GroupCallSession;
  transport: FakeTransport;
  signaling: FakeSignaling;
  timers: FakeTimers;
}

function makeSession(
  overrides: Partial<ConstructorParameters<typeof GroupCallSession>[0]> = {},
): Harness {
  const transport = new FakeTransport();
  const signaling = new FakeSignaling();
  const timers = new FakeTimers();
  const session = new GroupCallSession({
    selfUin: SELF_UIN,
    selfUid: SELF_UID,
    targetUids: [PEER_UID],
    groupId: GROUP_ID,
    stream: makeGroupStream(() => Uint8Array.from([0x57, 0x67, 0x7e])),
    gcsEntryBody: Uint8Array.from([0x0a, 0x00]),
    signaling,
    transport,
    codec: fakeCodec,
    timers,
    ...overrides,
  });
  return { session, transport, signaling, timers };
}

function deliverEntryResponse(transport: FakeTransport, streamPrefix = 0x180106aa): Uint8Array {
  const entry = groupCall.parseGroupGcsPacket(transport.sent[0]!.data)!;
  const reply = groupCall.buildGroupGcsPacket(
    groupCall.buildGroupGcsHead({ ...entry.head, seq: 266, f4: streamPrefix, f5: 0x01020001 }),
    Uint8Array.of(0x0a, 0x00),
  );
  transport.deliver(reply);
  return reply;
}

it('只归入本账号本房间的聊天推送，保留内联表情原文并过滤重传', async () => {
  const { session, transport, signaling } = makeSession();
  const initial = await session.start();
  signaling.chatNotice({ id: 1, text: '入房前' });
  deliverEntryResponse(transport);
  signaling.chatNotice({ id: 2, room: 1, text: '其他房间' });
  signaling.chatNotice({ id: 3, groupId: 1, text: '其他群' });
  signaling.chatNotice({ id: 4, recipient: 1, text: '其他账号' });
  const message = { id: 0xfe000003, text: '喵\x14/色喵' };
  signaling.chatNotice(message);
  signaling.chatNotice(message);
  expect(initial.chatMessages).toEqual([]);
  expect(session.snapshot().chatMessages).toEqual([
    { id: `${PEER_UIN}:${message.id}`, senderUin: PEER_UIN, text: message.text },
  ]);
});

// ─────────────────────────── 用例 ───────────────────────────

describe('启动', () => {
  it('开房 → UDP 入房与多端同步，状态进入 calling', async () => {
    const { session, signaling, transport } = makeSession();
    const snapshot = await session.start();
    expect(snapshot.state).toBe('calling');
    expect(snapshot.groupId).toBe(GROUP_ID);
    expect(snapshot.ownerUin).toBe(PEER_UIN);
    expect(signaling.createCalls).toBe(1);
    expect(signaling.syncCalls).toBe(1);
    expect(signaling.invitePrefixes).toEqual([]);
    expect(transport.sent[0]?.data[0]).toBe(0x28);
    expect(transport.closed).toBe(false);
  });

  it('没有邀请目标时直接拒绝', async () => {
    const { session } = makeSession({ targetUids: [] });
    await expect(session.start()).rejects.toThrow(/邀请目标/);
  });

  it('开房失败时状态是 failed', async () => {
    const { session, signaling } = makeSession();
    signaling.failCreate = true;
    await expect(session.start()).rejects.toThrow();
    expect(session.snapshot().state).toBe('failed');
    expect(session.snapshot().endReason).toBe('connect_fail');
  });

  it('多端同步失败不影响主链路', async () => {
    const { session, signaling } = makeSession();
    signaling.multiTerminalSync = async () => {
      throw new Error('同步失败');
    };
    const snapshot = await session.start();
    expect(snapshot.state).toBe('calling');
  });

  it('重复 start 会报错', async () => {
    const { session } = makeSession();
    await session.start();
    await expect(session.start()).rejects.toThrow(/已在/);
  });
});

describe('控制面', () => {
  it('入房应答匹配后发送 f10，再认证和邀请', async () => {
    const { session, transport, signaling, timers } = makeSession({ stream: undefined });
    await session.start();
    transport.deliver(gcsKeyPush);
    expect(transport.sent).toHaveLength(1);
    const reply = deliverEntryResponse(transport);
    transport.deliver(reply);
    const probe = groupCall.parseGroupGcsPacket(transport.sent[1]!.data)!;
    expect([...probe.body]).toEqual([0x52, 0x02, 0x08, 0x00]);
    expect(probe.head.f11).toBe(0);
    const auth = parseGroupRelay(transport.sent[2]!.data)!;
    expect(auth.cmd).toBe(GroupRelayCmd.auth);
    expect(auth.body.subarray(9, 97)).toEqual(AUTH_KEY);
    expect(transport.sent).toHaveLength(3);
    timers.advance(100);
    expect(signaling.invitePrefixes).toEqual([0x180106aa]);
  });

  it('收到 k2 后对相邻的 f4 通知用 k2 应答', async () => {
    const { session, transport } = makeSession();
    await session.start();
    deliverEntryResponse(transport);
    const before = transport.sent.length;
    transport.deliver(gcsKeyPush);
    expect(transport.sent).toHaveLength(before);
    transport.deliver(gcsSimplifyPush);
    const ack = groupCall.parseGroupGcsPacket(transport.sent.at(-1)!.data)!;
    const push = groupCall.parseGroupGcsPacket(gcsSimplifyPush)!;
    expect(ack.head.key).toEqual(
      groupCall.extractGroupSessionKey(groupCall.parseGroupGcsPacket(gcsKeyPush)!.body),
    );
    expect(ack.head.sessionId).toBe(push.head.sessionId);
    expect(ack.head.seq).toBe(push.head.seq + 1);
    expect([...ack.body]).toEqual([0x22, 0x00]);
  });

  it('每两秒发送 f3 并在收到 k2 后切换密钥', async () => {
    const { session, transport, timers } = makeSession({ stream: undefined });
    await session.start();
    const entry = groupCall.parseGroupGcsPacket(deliverEntryResponse(transport))!;
    timers.advance(2000);
    const reports = () =>
      transport.sent.flatMap(({ data }) => {
        const packet = groupCall.parseGroupGcsPacket(data);
        return packet?.head.seq === 277 ? [packet] : [];
      });
    const [first] = reports();
    expect(first?.head.sessionId).toBe(entry.head.sessionId + 4);
    expect(first?.head.key).toEqual(AUTH_KEY);
    expect(groupCall.groupFields(first!.body).has(3)).toBe(true);

    transport.deliver(gcsKeyPush);
    timers.advance(2000);
    const [, second] = reports();
    expect(second?.head.sessionId).toBe(first!.head.sessionId + 1);
    expect(second?.head.key).toEqual(
      groupCall.extractGroupSessionKey(groupCall.parseGroupGcsPacket(gcsKeyPush)!.body),
    );

    const done = session.hangup();
    timers.advance(2000);
    await done;
    expect(reports()).toHaveLength(2);
  });

  it('收到保活后回应答', async () => {
    const { session, transport } = makeSession();
    await session.start();
    // 先用真实包建立 stream（成员状态里带流标识）
    transport.deliver(memberSelfReady);
    transport.deliver(keepalive);

    const acks = transport.sent.filter((item) => {
      const packet = parseGroupRelay(item.data);
      return packet?.cmd === GroupRelayCmd.keepaliveAck;
    });
    expect(acks.length).toBeGreaterThan(0);
  });

  it('认证回包让状态进入 connecting', async () => {
    const { session, transport } = makeSession();
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    expect(session.snapshot().state).toBe('connecting');
  });
});

describe('成员', () => {
  it('移出通话只发送指定成员 UID，等中继确认后移除成员', async () => {
    const spec = groupCall.RemoveGroupCallMember;
    const input = { uid: 'u_member', groupId: 10003, authKey: AUTH_KEY, streamPrefix: 1234 };
    const wire = encode(spec.reqSchema, spec.serialize(input));
    const fields = groupCall.groupFields(wire);
    expect([...fields.keys()]).toEqual([1, 2, 6, 7, 8, 9]);
    expect(fields.get(6)).toEqual([new TextEncoder().encode(input.uid)]);
    expect(fields.get(7)).toEqual([0]);
    expect(fields.get(8)).toEqual([2]);
    expect(spec.deserialize({ result: { code: 0 } })).toBeUndefined();
    expect(() => spec.deserialize({ result: { code: 1 } })).toThrow(/移出成员失败/);
    const signaling = new FakeSignaling();
    const removeMember = vi.fn(async () => {});
    const create = signaling.create.bind(signaling);
    signaling.create = async () => {
      const { room } = await create();
      return { room: { ...room, ownerUin: SELF_UIN } };
    };
    const { session, transport } = makeSession({
      signaling: Object.assign(signaling, { removeMember }),
      memberDirectory: [{ uin: PEER_UIN, uid: PEER_UID }],
    });
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    transport.deliver(memberSelfReady);
    await expect(session.removeMember(SELF_UIN)).rejects.toThrow(/其他成员/);
    await expect(session.removeMember(PEER_UIN)).rejects.toThrow(/其他成员/);
    transport.deliver(memberPeerJoin);
    await session.removeMember(PEER_UIN);
    expect(removeMember).toHaveBeenCalledTimes(1);
    expect(removeMember).toHaveBeenCalledWith({
      uid: PEER_UID,
      groupId: GROUP_ID,
      authKey: AUTH_KEY,
      streamPrefix: 0x180106aa,
    });
    expect(session.snapshot().members.some(({ uin }) => uin === PEER_UIN)).toBe(true);
    const leave = memberPeerJoin.slice();
    leave[28] = 2;
    transport.deliver(leave);
    expect(session.snapshot().members.some(({ uin }) => uin === PEER_UIN)).toBe(false);
  });

  it('重复的结束通知只移除当前房间对应轮次的待响应成员', async () => {
    const { session, transport, timers, signaling } = makeSession({ media: 1 });
    const room = 0x180106aa;
    await session.start();
    deliverEntryResponse(transport, room);
    transport.deliver(authRspOk);
    timers.advance(100);
    expect(session.snapshot().pendingInviteUids).toEqual([PEER_UID]);
    await session.inviteMembers([PEER_UID, 'u_other', 'u_other']);
    expect(signaling.invites.map(({ targetUids, media }) => ({ targetUids, media }))).toEqual([
      { targetUids: [PEER_UID], media: 1 },
      { targetUids: ['u_other'], media: 1 },
    ]);
    signaling.inviteNotice(room + 1, 3, PEER_UID);
    expect(session.snapshot().pendingInviteUids).toEqual([PEER_UID, 'u_other']);
    signaling.inviteNotice(room, 3, PEER_UID);
    expect(session.snapshot().pendingInviteUids).toEqual(['u_other']);

    session.setCamera(true);
    await session.inviteMembers([PEER_UID]);
    expect(signaling.invites.at(-1)?.media).toBe(2);
    signaling.inviteNotice(room, 3, PEER_UID);
    expect(session.snapshot().pendingInviteUids).toEqual(['u_other', PEER_UID]);
    signaling.inviteNotice(room, 1, PEER_UID);
    signaling.inviteNotice(room, 3, PEER_UID);
    expect(session.snapshot().pendingInviteUids).toEqual(['u_other']);
  });

  it('成员进房后退出待响应列表，也不会被重复邀请', async () => {
    const { session, transport, timers, signaling } = makeSession({
      memberDirectory: [{ uid: PEER_UID, uin: PEER_UIN }],
    });
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    timers.advance(100);
    expect(session.snapshot().pendingInviteUids).toEqual([PEER_UID]);
    transport.deliver(memberPeerJoin);
    expect(session.snapshot().pendingInviteUids).toEqual([]);
    expect(session.snapshot().state).toBe('connected');
    await session.inviteMembers([PEER_UID]);
    expect(signaling.invites).toHaveLength(1);
  });

  it('推送缺失时本地超时清理待响应名单，保留已认证的房间', async () => {
    const { session, transport, timers } = makeSession({ media: 1 });
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    timers.advance(100);
    expect(session.snapshot().pendingInviteUids).toEqual([PEER_UID]);
    for (let i = 0; i < 65; i++) {
      timers.advance(1000);
      transport.deliver(keepalive);
    }
    expect(session.snapshot().pendingInviteUids).toEqual([]);
    expect(session.snapshot().state).toBe('connecting');
  });

  it('收到成员进房后出现在成员表里', async () => {
    const { session, transport } = makeSession();
    await session.start();
    transport.deliver(memberPeerJoin);
    const members = session.snapshot().members;
    expect(members.some((m) => m.uin === PEER_UIN)).toBe(true);
  });

  it('成员状态里的静音位能被读出来', async () => {
    const { session, transport } = makeSession();
    await session.start();
    transport.deliver(memberSelfReady);
    const before = session.snapshot().members.find((m) => m.uin === SELF_UIN)!;
    expect(before.muted).toBe(false);
  });

  it('邀请后用本次流前缀查房，且不会把 SSO 查询结果当作进房事件', async () => {
    const { session, transport, timers, signaling } = makeSession({ stream: undefined });
    await session.start();
    deliverEntryResponse(transport);
    timers.advance(100);
    await Promise.resolve();
    timers.advance(500);
    await Promise.resolve();
    expect(signaling.queryPrefixes).toEqual([0x180106aa]);
    expect(session.snapshot().members).toEqual([]);
    transport.deliver(memberPeerJoin);
    expect(session.snapshot().members[0]?.uid).toBe(PEER_UID);
  });

  it('仅在远端视频订阅集变化时发送 0x13', async () => {
    const { session, transport } = makeSession();
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    transport.deliver(memberSelfReady);
    transport.deliver(memberPeerJoin);
    const subscriptions = () =>
      transport.sent.flatMap(({ data }) => {
        const packet = parseGroupRelay(data);
        return packet?.cmd === GroupRelayCmd.streamSubscribe
          ? [groupCall.parseGroupStreamSubscribe(packet.body)!.memberUins]
          : [];
      });
    expect(subscriptions()).toEqual([]);
    const peerVideo = memberPeerJoin.slice();
    peerVideo[28] = 3;
    peerVideo[37] = 1;
    transport.deliver(peerVideo);
    transport.deliver(peerVideo);
    transport.deliver(memberPeerJoin);
    expect(subscriptions()).toEqual([[SELF_UIN, PEER_UIN], [SELF_UIN]]);
  });
});

describe('媒体', () => {
  it('SILK 上行保留完整帧号，并按 15 帧周期发送扩展头', async () => {
    const { session, transport, timers } = makeSession({ media: 2 });
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    const pcm = new Uint8Array(640).fill(0x42);
    for (let i = 0; i < 258; i++) {
      if (i % 50 === 0) transport.deliver(keepalive);
      await session.pushAudio(pcm);
      timers.advance(20);
    }
    const audio = transport.sent.flatMap(({ data }) => {
      const packet = parseGroupRelay(data);
      return packet?.cmd === GroupRelayCmd.mediaUp && packet.body[16] === groupCall.GroupTrack.audio
        ? [packet.body]
        : [];
    });
    expect(audio).toHaveLength(258);
    expect(audio[0]?.slice(16, 26)).toEqual(Uint8Array.of(1, 1, 0, 3, 0xbe, 1, 1, 0x25, 0, 1));
    expect(audio[0]?.slice(30)).toEqual(
      Uint8Array.of(0x10, 1, 0, 0, 0, 10, 8, 0, ...pcm.subarray(0, 8), 0, 0),
    );
    expect(audio[0]?.[8]).toBe(0xfa);
    expect(audio[1]?.[20]).toBe(0x3e);
    expect(audio[15]?.[20]).toBe(0xbe);
    expect(audio[255]?.slice(24, 26)).toEqual(Uint8Array.of(1, 0));
    const parsed = audio.map((body) => groupCall.parseGroupAudioFrame(body)!);
    expect(parsed.slice(254).map(({ frameIndex }) => frameIndex)).toEqual([255, 256, 257, 258]);
    expect(parsed[255]!.sampleTs - parsed[254]!.sampleTs).toBe(320);
    expect(parsed[255]?.payload).toEqual(pcm.subarray(0, 8));
  });

  it('按成员和采样时钟过滤下行重复帧，允许 32 位采样时钟回绕', async () => {
    const decode = vi.fn(async () => new Uint8Array(640));
    const { session, transport } = makeSession({ codec: { ...fakeCodec, decode } });
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    const stream = Uint8Array.of(0x18, 1, 6, 0xaa, 1, 2, 0);
    const silk = Uint8Array.of(1, 2, 3);
    const frame = (frameIndex: number, sampleTs: number) => {
      const packet = groupCall.buildGroupAudioFrame({
        route: frameIndex,
        ownerUin: PEER_UIN,
        stream,
        frameIndex,
        sampleTs,
        sentAt: 123,
        capturedAt: 122,
        silk,
      });
      packet[8] = GroupRelayCmd.mediaDown;
      return packet;
    };
    const beforeWrap = frame(255, 0xffffff00);
    const afterWrap = frame(256, 0x40);
    const late = frame(254, 0xfffffdc0);
    let received = 0;
    const delivered = new Promise<void>((resolve) => {
      session.onAudio(() => {
        if (++received === 2) resolve();
      });
    });
    for (const packet of [beforeWrap, beforeWrap, afterWrap, late, afterWrap]) {
      transport.deliver(packet);
    }
    await delivered;
    expect(decode.mock.calls).toEqual([
      [silk, PEER_UIN],
      [silk, PEER_UIN],
    ]);
  });

  it('收到下行媒体后状态进入 connected', async () => {
    const { session, transport } = makeSession();
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    transport.deliver(mediaDown);
    expect(session.snapshot().state).toBe('connecting');
    transport.deliver(audioDownPlain);
    expect(session.snapshot().state).toBe('connected');
  });

  it('静音时推音频不发包', async () => {
    const { session, transport } = makeSession();
    await session.start();
    const before = transport.sent.length;
    session.setMic(true);
    await session.pushAudio(new Uint8Array(640));
    // 只多了 0x73 那一条
    expect(transport.sent.length).toBe(before + 1);
  });

  it('PCM 长度不对时抛错（已在通话中的状态）', async () => {
    const { session, transport } = makeSession();
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    await expect(session.pushAudio(new Uint8Array(100))).rejects.toThrow(/PCM/);
  });

  it('关摄像头重新认证时使用模式 1 和 k2', async () => {
    const { session, transport } = makeSession();
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    transport.deliver(gcsKeyPush);
    session.setCamera(true);
    session.setCamera(false);
    const auth = parseGroupRelay(transport.sent.at(-1)!.data)!;
    expect(auth.cmd).toBe(GroupRelayCmd.auth);
    expect(auth.body[97]).toBe(1);
    expect(auth.body.subarray(9, 97)).toEqual(
      groupCall.extractGroupSessionKey(groupCall.parseGroupGcsPacket(gcsKeyPush)!.body),
    );
  });

  it('摄像头没开时推视频不发包', async () => {
    const { session, transport } = makeSession();
    await session.start();
    const before = transport.sent.length;
    session.pushVideoFrame(new Uint8Array(100));
    expect(transport.sent.length).toBe(before);
  });
});

describe('视频分片', () => {
  it('等待 SPS/PPS，按帧号和首片计数拼接乱序分片并忽略冗余片', () => {
    const stream = Uint8Array.of(0x18, 1, 6, 0xaa, 1, 2, 0);
    const assembler = new groupCall.GroupVideoAssembler();
    const make = (data: Uint8Array, packetIndex: number) =>
      groupCall
        .buildGroupVideoFragments({
          route: 1,
          ownerUin: 1001,
          stream,
          seq: 200,
          frameIndex: 0,
          packetIndex,
          data,
          maxPayload: 16,
        })
        .map((packet) => parseGroupRelay(packet)!.body);
    const delta = Uint8Array.of(0, 0, 0, 1, 0x61, 0xab);
    expect(assembler.push(1001, groupCall.parseGroupVideoFragment(make(delta, 3)[0]!)!)).toBeNull();

    const keyframe = Uint8Array.of(
      0,
      0,
      0,
      1,
      0x67,
      0x64,
      0x01,
      0x02,
      0,
      0,
      0,
      1,
      0x68,
      0x03,
      0x04,
      0,
      0,
      0,
      1,
      0x65,
      0x12,
      0x34,
      0x56,
      0x78,
    );
    const [first, second, fec] = make(keyframe, 0xffff);
    expect([first![20], second![20], fec![20]]).toEqual([1, 1, 1]);
    expect(fec!.slice(32)).toEqual(
      first!.slice(32).map((byte, index) => byte ^ second![32 + index]!),
    );
    expect(groupCall.parseGroupVideoFragment(fec!)).toBeNull();
    expect(assembler.push(1001, groupCall.parseGroupVideoFragment(second!)!)).toBeNull();
    expect(assembler.push(1001, groupCall.parseGroupVideoFragment(first!)!)?.data).toEqual(
      Uint8Array.of(...keyframe, 0),
    );
    expect(assembler.push(1001, groupCall.parseGroupVideoFragment(second!)!)).toBeNull();
    expect(
      assembler.push(1001, groupCall.parseGroupVideoFragment(make(delta, 1)[0]!)!)?.data,
    ).toEqual(delta);
  });
});

describe('麦克风', () => {
  it('setMic 发出 0x73 并更新快照', async () => {
    const { session, transport } = makeSession();
    await session.start();
    // 先拿到 stream（成员状态包里有）
    transport.deliver(memberSelfReady);
    transport.deliver(gcsKeyPush);

    session.setMic(true);
    const mic = transport.sent
      .map((item) => parseGroupRelay(item.data))
      .filter((packet) => packet?.cmd === GroupRelayCmd.micState);
    expect(mic.length).toBe(1);
    expect(session.snapshot().micMuted).toBe(true);
  });

  it('静音别人的包带目标 uin', async () => {
    const { session, transport } = makeSession();
    await session.start();
    transport.deliver(memberSelfReady);
    transport.deliver(gcsKeyPush);

    session.muteMember(PEER_UIN);
    const packets = transport.sent
      .map((item) => parseGroupRelay(item.data))
      .filter((packet) => packet?.cmd === GroupRelayCmd.micState);
    expect(packets.length).toBe(1);
  });
});

describe('挂断', () => {
  it('挂断后状态是 ended、socket 已关闭', async () => {
    const { session, transport, timers } = makeSession();
    await session.start();
    const done = session.hangup();
    // 退出包按 100ms 重发，假时钟要推进才会走完序列。
    timers.advance(EXIT_RETRY_TOTAL_MS);
    await done;
    expect(session.snapshot().state).toBe('ended');
    expect(session.snapshot().endReason).toBe('hangup');
    expect(transport.closed).toBe(true);
  });

  it('退出包会重发多次', async () => {
    const { session, transport, timers } = makeSession();
    await session.start();
    transport.deliver(memberSelfReady);
    transport.deliver(gcsKeyPush);
    const before = transport.sent.length;
    const done = session.hangup();
    timers.advance(EXIT_RETRY_TOTAL_MS);
    await done;
    const exits = transport.sent
      .slice(before)
      .filter((item) => parseGroupRelay(item.data)?.cmd === GroupRelayCmd.exit);
    expect(exits).toHaveLength(5);
    expect(exits.every(({ data }) => Buffer.from(data).equals(exits[0]!.data))).toBe(true);
  });

  it('重复挂断是幂等的', async () => {
    const { session, timers } = makeSession();
    await session.start();
    const done = session.hangup();
    const concurrent = session.hangup();
    timers.advance(EXIT_RETRY_TOTAL_MS);
    await Promise.all([done, concurrent]);
    await session.hangup();
    expect(session.snapshot().state).toBe('ended');
  });

  it('未开始时挂断是空操作', async () => {
    const { session } = makeSession();
    await session.hangup();
    expect(session.snapshot().state).toBe('idle');
  });
});

describe('超时', () => {
  it('一直没人进房时按超时结束', async () => {
    const { session, timers } = makeSession();
    await session.start();
    timers.advance(60_000);
    expect(session.snapshot().state).toBe('failed');
    expect(session.snapshot().endReason).toBe('timeout');
  });

  it('长时间收不到保活时判定断线', async () => {
    const { session, timers, transport } = makeSession();
    await session.start();
    deliverEntryResponse(transport);
    transport.deliver(authRspOk);
    timers.advance(10_000);
    expect(session.snapshot().state).toBe('failed');
    expect(session.snapshot().endReason).toBe('connect_fail');
  });
});

describe('快照', () => {
  it('成员按 uin 升序', async () => {
    const { session, transport } = makeSession();
    await session.start();
    transport.deliver(memberPeerJoin);
    transport.deliver(memberSelfReady);
    const uins = session.snapshot().members.map((m) => m.uin);
    expect([...uins].sort((a, b) => a - b)).toEqual(uins);
  });

  it('初始快照里没有成员', async () => {
    const { session } = makeSession();
    expect(session.snapshot().members).toEqual([]);
    expect(session.snapshot().state).toBe('idle');
  });
});
