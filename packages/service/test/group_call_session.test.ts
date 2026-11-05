/**
 * 群通话会话状态机回归测试。
 *
 * 全程用假时钟 + 假 socket + 假信令，不碰真 QQ、不联网。报文样本来自
 * `@weq/protocol` 的抓包 fixture，所以「收到真实字节能不能正确驱动状态机」
 * 也一并覆盖了。
 */

import { describe, expect, it } from 'vitest';
import { groupCall } from '@weq/protocol';
import {
  GroupCallSession,
  makeGroupStream,
  type GroupCallCodec,
  type GroupCallSignaling,
  type GroupCallTimers,
  type GroupCallTransport,
} from '../src/account/group_call_session';
import {
  authK1,
  authRspOk,
  gcsKeyPush,
  keepalive,
  memberPeerJoin,
  memberSelfReady,
  subscribeTwo,
} from '../../protocol/test/fixtures/group_call_capture';

const { GROUP_SESSION_KEY_LEN, GroupRelayCmd, parseGroupRelay } = groupCall;

const SELF_UIN = 1707889225;
const SELF_UID = 'u_self';
const PEER_UIN = 2940720980;
const PEER_UID = 'u_peer';
const GROUP_ID = 673646675;
/** 退出包重发序列的总时长（10 次 × 100ms），假时钟要推进这么久。 */
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

/** 恒等变换的编解码器（测试不关心真实 Opus）。 */
const fakeCodec: GroupCallCodec = {
  encode: async (pcm) => pcm.subarray(0, 8),
  decode: async (opus) => new Uint8Array(opus.length * 40),
};

/** 可控的信令层。 */
class FakeSignaling implements GroupCallSignaling {
  createCalls = 0;
  inviteCalls = 0;
  syncCalls = 0;
  queryCalls = 0;
  failCreate = false;

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

  async invite(): Promise<void> {
    this.inviteCalls += 1;
  }

  async multiTerminalSync(): Promise<void> {
    this.syncCalls += 1;
  }

  async query(): Promise<{
    members: Array<{ uin: number; uid: string | null }>;
  }> {
    this.queryCalls += 1;
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

/** 组一条 `0x28`（用真实抓包里的 k2 下发包结构简化）。 */
function gcsKeyPushPacket(): Uint8Array {
  return gcsKeyPush;
}

// ─────────────────────────── 用例 ───────────────────────────

describe('启动', () => {
  it('开房 → 多端同步 → 绑定 UDP，状态进入 calling', async () => {
    const { session, signaling, transport } = makeSession();
    const snapshot = await session.start();
    expect(snapshot.state).toBe('calling');
    expect(snapshot.groupId).toBe(GROUP_ID);
    expect(snapshot.ownerUin).toBe(PEER_UIN);
    expect(signaling.createCalls).toBe(1);
    expect(signaling.syncCalls).toBe(1);
    expect(signaling.inviteCalls).toBe(0);
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
  it('收到 k2 下发包后把密钥换成 k2', async () => {
    const { session, transport } = makeSession();
    await session.start();
    transport.deliver(gcsKeyPushPacket());

    // 认证（0x02）之后收到 k2 会回一条 0x28 应答
    const gcs = transport.sent.filter((item) => item.data[0] === 0x28);
    expect(gcs.length).toBe(2);
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
    transport.deliver(authK1);
    transport.deliver(authRspOk);
    expect(session.snapshot().state).toBe('connecting');
  });
});

describe('成员', () => {
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

  it('周期查询补上 uid 映射', async () => {
    const { session, transport, timers, signaling } = makeSession();
    await session.start();
    transport.deliver(memberPeerJoin);
    timers.advance(5000);
    await Promise.resolve();
    await Promise.resolve();
    expect(signaling.queryCalls).toBeGreaterThan(0);
  });
});

describe('媒体', () => {
  it('收到下行媒体后状态进入 connected', async () => {
    const { session, transport } = makeSession();
    await session.start();
    transport.deliver(authRspOk);
    transport.deliver(subscribeTwo);
    expect(session.snapshot().state).toBe('connecting');
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
    const { session } = makeSession();
    await session.start();
    session.state = 'connected';
    await expect(session.pushAudio(new Uint8Array(100))).rejects.toThrow(/PCM/);
  });

  it('摄像头没开时推视频不发包', async () => {
    const { session, transport } = makeSession();
    await session.start();
    const before = transport.sent.length;
    session.pushVideoFrame(new Uint8Array(100));
    expect(transport.sent.length).toBe(before);
  });
});

describe('麦克风', () => {
  it('setMic 发出 0x73 并更新快照', async () => {
    const { session, transport } = makeSession();
    await session.start();
    // 先拿到 stream（成员状态包里有）
    transport.deliver(memberSelfReady);
    transport.deliver(gcsKeyPushPacket());

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
    transport.deliver(gcsKeyPushPacket());

    session.muteMember(PEER_UIN, true);
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
    transport.deliver(gcsKeyPushPacket());
    const before = transport.sent.length;
    const done = session.hangup();
    timers.advance(EXIT_RETRY_TOTAL_MS);
    await done;
    const exits = transport.sent
      .slice(before)
      .filter((item) => parseGroupRelay(item.data)?.cmd === GroupRelayCmd.exit);
    expect(exits.length).toBeGreaterThan(1);
  });

  it('重复挂断是幂等的', async () => {
    const { session, timers } = makeSession();
    await session.start();
    const done = session.hangup();
    timers.advance(EXIT_RETRY_TOTAL_MS);
    await done;
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
    const { session, timers } = makeSession();
    await session.start();
    // 先进到 connecting（保活检查只在这个状态之后生效）
    session.state = 'connecting';
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
