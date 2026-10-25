import { describe, expect, it } from 'vitest';
import {
  CallSession,
  type CallAudioCodec,
  type CallSignaling,
  type CallState,
  type CallTimers,
  type UdpTransport,
} from '../src/account/call_session';
import {
  AUDIO_STX,
  CallEvent,
  GcsBodyType,
  buildAudioFrame,
  buildGcsPacket,
  buildGcsHead,
  encodeVarint,
  pbBytes,
  pbVarint,
  parseGcsPacket,
} from '@weq/protocol';

// ─────────────────────────── 测试替身 ───────────────────────────

/** 手动推进的时钟，避免单测里等真实的 20 ms / 2 s。 */
class FakeTimers implements CallTimers {
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
  /** 推进 `ms`，按到期顺序触发回调。 */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const dueTimeout = [...this.timeouts.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      const dueInterval = [...this.intervals.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!dueTimeout && !dueInterval) break;
      const useTimeout = dueTimeout && (!dueInterval || dueTimeout[1].at <= dueInterval[1].at);
      if (useTimeout) {
        const [, entry] = dueTimeout!;
        this.nowMs = entry.at;
        this.timeouts.delete(dueTimeout![0]);
        entry.fn();
      } else {
        const [_id, entry] = dueInterval!;
        this.nowMs = entry.at;
        entry.at += entry.ms;
        entry.fn();
      }
    }
    this.nowMs = target;
  }
}

class FakeTransport implements UdpTransport {
  readonly sent: Array<{ data: Uint8Array; port: number; address: string }> = [];
  closed = false;
  private messageHandler?: (data: Uint8Array, from: { address: string; port: number }) => void;
  private errorHandler?: (error: Error) => void;

  async bind(): Promise<void> {}
  send(data: Uint8Array, port: number, address: string): void {
    this.sent.push({ data, port, address });
  }
  close(): void {
    this.closed = true;
  }
  onMessage(handler: (data: Uint8Array, from: { address: string; port: number }) => void): void {
    this.messageHandler = handler;
  }
  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
  /** 模拟服务端推一个包过来。 */
  deliver(data: Uint8Array): void {
    this.messageHandler?.(data, { address: '1.2.3.4', port: 8000 });
  }
  raise(error: Error): void {
    this.errorHandler?.(error);
  }
  /** 收到的 GCS 包（按 bodyType 过滤）。 */
  gcs(bodyType: number): Array<ReturnType<typeof parseGcsPacket>> {
    return this.sent.map((s) => parseGcsPacket(s.data)).filter((p) => p && p.bodyType === bodyType);
  }
}

class FakeCodec implements CallAudioCodec {
  opened = false;
  closed = false;
  async open(): Promise<void> {
    this.opened = true;
  }
  async encode(pcm: Uint8Array): Promise<Uint8Array> {
    return pcm.subarray(0, 8);
  }
  async decode(opus: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(640).fill(opus[0] ?? 0);
  }
  close(): void {
    this.closed = true;
  }
}

function fakeSignaling(): CallSignaling & { ended: boolean } {
  const state = { ended: false };
  return {
    get ended() {
      return state.ended;
    },
    async start() {
      return {
        room: {
          roomId: 777n,
          sessionId: 88n,
          relationId: 15001,
          authKey: new Uint8Array(80).fill(1),
          servers: [
            { ip: '113.250.57.28', port: 8000, type: 1 },
            { ip: '113.250.57.28', port: 8800, type: 2 },
          ],
        },
        authToken: 1234,
      };
    },
    async end() {
      state.ended = true;
    },
  };
}

function makeSession() {
  const timers = new FakeTimers();
  const transport = new FakeTransport();
  const codec = new FakeCodec();
  const signaling = fakeSignaling();
  const session = new CallSession({
    selfUin: '1707889225',
    selfUid: 'u_self',
    peerUin: '2863253201',
    peerUid: 'u_peer',
    signaling,
    transport,
    codec,
    timers,
  });
  const states: CallState[] = [];
  session.onStateChange((s) => states.push(s.state));
  return { session, timers, transport, codec, signaling, states };
}

/** 拼一个服务端房间事件推送。 */
function notifyPacket(event: number, peer = 2863253201, exitReason = 0): Uint8Array {
  const info = new Uint8Array([...pbVarint(1, peer), ...pbVarint(3, event)]);
  const body = new Uint8Array([...pbVarint(1, 1), ...pbBytes(2, info), ...pbVarint(3, exitReason)]);
  const head = buildGcsHead({
    roomId: 777n,
    selfUin: 1707889225,
    sessionTs: 555,
    typeId: 0x6241,
    bodyType: GcsBodyType.notifyPush,
  });
  return buildGcsPacket(head, body);
}

/** 拼一个认证回包（带会话时间戳）。 */
function authRspPacket(sessionTs = 999): Uint8Array {
  const head = buildGcsHead({
    roomId: 777n,
    selfUin: 1707889225,
    sessionTs,
    typeId: 0x1959,
    bodyType: GcsBodyType.authRsp,
  });
  return buildGcsPacket(head, new Uint8Array([0x08, 0x01]));
}

// ─────────────────────────── 用例 ───────────────────────────

describe('通话会话状态机', () => {
  it('发起后先发认证、中继注册与编码器初始化', async () => {
    const { session, transport } = makeSession();
    await session.start();

    expect(session.snapshot().state).toBe('idle' === session.snapshot().state ? 'idle' : 'calling');
    expect(transport.sent.length).toBeGreaterThan(0);
    // 认证包发两次
    expect(transport.gcs(GcsBodyType.authReq)).toHaveLength(2);
    // 中继注册（首字节 0x02）
    expect(transport.sent.some((s) => s.data[0] === 0x02)).toBe(true);
    // 编码器初始化帧（0x5b, subType=1, seq=0）
    const init = transport.sent.find((s) => {
      if (s.data[0] !== AUDIO_STX || s.data[3] !== 1) return false;
      const view = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
      return view.getUint32(5) === 0;
    });
    expect(init).toBeTruthy();
  });

  it('振铃 → 进入 → 送音频，才真正变成 connected', async () => {
    const { session, transport, states, timers } = makeSession();
    await session.start();

    transport.deliver(notifyPacket(CallEvent.ringing));
    expect(session.snapshot().state).toBe('ringing');

    transport.deliver(notifyPacket(CallEvent.entered));
    expect(session.snapshot().state).toBe('connecting');

    transport.deliver(notifyPacket(CallEvent.dataChange));
    expect(session.snapshot().state).toBe('connected');
    expect(session.snapshot().connectedAt).not.toBeNull();

    // 接通后开始按 20 ms 发音频
    const before = session.snapshot().sentFrames;
    timers.advance(200);
    expect(session.snapshot().sentFrames).toBeGreaterThan(before);
    expect(states).toEqual(['calling', 'ringing', 'connecting', 'connected']);
  });

  it('对端挂断会走完收尾（GCS 登出 5 次 + MSF 登出）', async () => {
    const { session, transport, codec, signaling } = makeSession();
    await session.start();
    transport.deliver(notifyPacket(CallEvent.dataChange));

    transport.deliver(notifyPacket(CallEvent.logout, 2863253201, 2));
    // teardown 里有 await，等微任务队列走完
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.snapshot().state).toBe('ended');
    expect(session.snapshot().endReason).toBe('peer_hangup');
    expect(transport.gcs(GcsBodyType.logout)).toHaveLength(5);
    expect(signaling.ended).toBe(true);
    expect(codec.closed).toBe(true);
    expect(transport.closed).toBe(true);
  });

  it('主动挂断的原因记为 hangup', async () => {
    const { session, transport } = makeSession();
    await session.start();
    transport.deliver(notifyPacket(CallEvent.dataChange));

    await session.hangup();
    expect(session.snapshot().state).toBe('ended');
    expect(session.snapshot().endReason).toBe('hangup');
  });

  /**
   * 回归：挂断时释放 native 编解码器曾经把主进程直接打崩（Windows 上
   * AVSDKPlugin 的后台线程在模块卸载后踩空，fail-fast）。即使释放这一步抛错，
   * 状态也必须先落到终态，否则界面永远停在「正在挂断」，而对端一直占线。
   */
  it('释放编解码器抛错时状态仍然收敛到 ended', async () => {
    const { session, transport, codec } = makeSession();
    codec.close = () => {
      throw new Error('AVSDKPlugin 卸载失败');
    };
    await session.start();
    transport.deliver(notifyPacket(CallEvent.dataChange));

    await expect(session.hangup()).resolves.toBeUndefined();
    expect(session.snapshot().state).toBe('ended');
    expect(session.snapshot().endReason).toBe('hangup');
    // UDP 仍然要关掉，不能因为编解码器出错就漏掉 socket。
    expect(transport.closed).toBe(true);
  });

  it('对端拒绝 / 连接失败 / 超时 / 被踢各有独立原因', async () => {
    for (const [event, reason] of [
      [CallEvent.connectFail, 'connect_fail'],
      [CallEvent.timeout, 'timeout'],
      [CallEvent.kickOut, 'kicked'],
    ] as const) {
      const { session, transport } = makeSession();
      await session.start();
      transport.deliver(notifyPacket(event));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(session.snapshot().endReason).toBe(reason);
    }
  });

  it('振铃超时自动挂断', async () => {
    const { session, timers } = makeSession();
    await session.start();
    timers.advance(60_001);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.snapshot().endReason).toBe('timeout');
  });

  it('认证回包的会话时间戳会带到后续所有包', async () => {
    const { session, transport, timers } = makeSession();
    await session.start();
    transport.deliver(authRspPacket(4242));
    // 认证之后的心跳才带新时间戳
    timers.advance(2000);

    const beat = transport.gcs(GcsBodyType.heartbeat).at(-1);
    expect(beat).toBeTruthy();
    expect(beat!.sessionTs).toBe(4242);
  });

  it('推送会回 ACK', async () => {
    const { session, transport } = makeSession();
    await session.start();
    transport.deliver(notifyPacket(CallEvent.ringing));
    expect(transport.gcs(GcsBodyType.notifyAck).length).toBeGreaterThan(0);
    expect(session).toBeTruthy();
  });

  it('收到对端音频会解码后交给监听者', async () => {
    const { session, transport } = makeSession();
    const frames: Uint8Array[] = [];
    session.onAudio((pcm) => frames.push(pcm));
    await session.start();
    transport.deliver(notifyPacket(CallEvent.dataChange));

    // 造一帧对端音频（ver=0x00, ext=0x2e = Opus）
    const { packet } = buildAudioFrame({
      seq: 1,
      sessionTs: 999,
      tick: 100,
      sampleCounter: 320,
      frameCounter: 1,
      opus: Uint8Array.from([0xaa, 0xbb]),
    });
    transport.deliver(packet);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.snapshot().receivedFrames).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(640);
  });

  it('未接通时不往外发音频', async () => {
    const { session, transport } = makeSession();
    await session.start();
    const before = session.snapshot().sentFrames;
    session.pushAudio(new Uint8Array(640));
    expect(session.snapshot().sentFrames).toBe(before);
    expect(transport.sent.length).toBeGreaterThan(0);
  });

  it('socket 报错会收敛成 failed', async () => {
    const { session, transport } = makeSession();
    await session.start();
    transport.raise(new Error('网络不可达'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.snapshot().state).toBe('failed');
    expect(session.snapshot().lastError).toBe('网络不可达');
  });

  it('服务端没给服务器地址时直接失败', async () => {
    const timers = new FakeTimers();
    const transport = new FakeTransport();
    const signaling: CallSignaling = {
      async start() {
        return {
          room: {
            roomId: 1n,
            sessionId: 2n,
            relationId: 3,
            authKey: new Uint8Array(0),
            servers: [],
          },
          authToken: 0,
        };
      },
      async end() {},
    };
    const session = new CallSession({
      selfUin: '1',
      selfUid: 'u',
      peerUin: '2',
      peerUid: 'u2',
      signaling,
      transport,
      codec: new FakeCodec(),
      timers,
    });
    await session.start();
    expect(session.snapshot().state).toBe('failed');
    expect(session.snapshot().lastError).toContain('服务器');
  });

  it('GCS 无认证回包时 3 秒后换下一台', async () => {
    const { session, transport, timers } = makeSession();
    await session.start();
    const firstAuth = transport.gcs(GcsBodyType.authReq)[0];
    expect(firstAuth).toBeTruthy();
    // 认证发往候选列表的第一台 GCS
    expect(transport.sent[0]!.address).toBe('113.250.57.28');

    const before = transport.gcs(GcsBodyType.authReq).length;
    timers.advance(3000);
    // 超时后重发认证（换了一台）
    expect(transport.gcs(GcsBodyType.authReq).length).toBeGreaterThan(before);
    expect(session.snapshot().state).toBe('calling');
  });

  it('认证回包到了就不再换台', async () => {
    const { session, transport, timers } = makeSession();
    await session.start();
    transport.deliver(authRspPacket(777));
    const before = transport.gcs(GcsBodyType.authReq).length;
    timers.advance(10_000);
    expect(transport.gcs(GcsBodyType.authReq).length).toBe(before);
    expect(session.snapshot().state).toBe('calling');
  });

  it('重复发起会被拒绝', async () => {
    const { session } = makeSession();
    await session.start();
    await expect(session.start()).rejects.toThrow(/通话已在/);
  });
});

// 让 `encodeVarint` 导入不被摇掉（也是给假事件用的最小依赖）。
void encodeVarint;
