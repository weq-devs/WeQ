/**
 * 通话会话的视频收发。
 *
 * 重点验证三件事：
 *   1. `0x5b` 的非音频子类型不再被静默丢弃（这是接视频前最大的坑）；
 *   2. 收到的分片能组装成完整帧、剥出 H.265 裸流交给监听器；
 *   3. 开关摄像头发的是**同一条**空体控制包（连发两次）。
 */

import { describe, expect, it } from 'vitest';
import {
  CallSession,
  type CallAudioCodec,
  type CallSignaling,
  type CallState,
  type CallTimers,
  type CallVideoEncoder,
  type UdpTransport,
  type VideoFramePayload,
  type VideoStreamInfo,
} from '../src/account/call_session';
import {
  AUDIO_HEADER_LEN,
  AUDIO_STX,
  CallEvent,
  GCS_STX,
  GcsBodyType,
  VIDEO_CTRL_SUB_TYPE,
  VIDEO_EXT_LEN,
  VIDEO_EXT_TYPE,
  VideoFrameAssembler,
  VideoSubType,
  buildGcsHead,
  buildGcsPacket,
  buildVideoControl,
  buildVideoKeepalive,
  parseGcsPacket,
  parseVideoPacket,
  pbBytes,
  pbVarint,
  videoFrameIndex,
} from '@weq/protocol';

// ─────────────────────────── 测试替身 ───────────────────────────

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
  /**
   * 推进时间。回调可能是 async（视频发送循环是 `void pumpVideo()`），
   * 所以每次触发后都要让出一轮微任务，否则 Promise 里的发包还没跑到。
   */
  async advanceAsync(ms: number): Promise<void> {
    await this.step(ms);
  }

  private async step(ms: number): Promise<void> {
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
        const [, entry] = dueInterval!;
        this.nowMs = entry.at;
        entry.at += entry.ms;
        entry.fn();
      }
      // 让出微任务，等 async 回调里的发包落地。
      await Promise.resolve();
    }
    this.nowMs = target;
  }

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
        const [, entry] = dueInterval!;
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
  onError(): void {}
  deliver(data: Uint8Array): void {
    this.messageHandler?.(data, { address: '1.2.3.4', port: 8000 });
  }
  /** 从指定来源投递（模拟对端直连发包）。 */
  deliverFrom(data: Uint8Array, from: { address: string; port: number }): void {
    this.messageHandler?.(data, from);
  }
  /** 按子类型筛出已发出的媒体包。 */
  media(subType: number): Uint8Array[] {
    return this.sent
      .filter((s) => s.data[0] === AUDIO_STX && s.data[3] === subType)
      .map((s) => s.data);
  }
  /** 按目的地址筛出已发出的媒体包。 */
  mediaTo(address: string, subType?: number): Uint8Array[] {
    return this.sent
      .filter(
        (s) =>
          s.data[0] === AUDIO_STX &&
          (subType === undefined || s.data[3] === subType) &&
          s.address === address,
      )
      .map((s) => s.data);
  }
  reset(): void {
    this.sent.length = 0;
  }
}

class FakeCodec implements CallAudioCodec {
  async open(): Promise<void> {}
  async encode(pcm: Uint8Array): Promise<Uint8Array> {
    return pcm.subarray(0, 8);
  }
  async decode(opus: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(640).fill(opus[0] ?? 0);
  }
  close(): void {}
}

/** 固定吐一帧的假编码器。 */
class FakeVideoEncoder implements CallVideoEncoder {
  closed = false;
  framesLeft: number;
  constructor(frames = 1) {
    this.framesLeft = frames;
  }
  async next(): Promise<Uint8Array | null> {
    if (this.framesLeft <= 0) return null;
    this.framesLeft--;
    return new Uint8Array([0, 0, 0, 1, 0x40, 0x01, 0x0c, 0x01]);
  }
  info(): VideoStreamInfo {
    return { width: 640, height: 360, profile: 1, codec: 'hevc' };
  }
  close(): void {
    this.closed = true;
  }
}

function fakeSignaling(): CallSignaling & { startedWith: unknown[] } {
  const startedWith: unknown[] = [];
  return {
    startedWith,
    async start(params) {
      startedWith.push(params);
      return {
        room: {
          roomId: 777n,
          sessionId: 88n,
          relationId: 15001,
          authKey: new Uint8Array(80).fill(1),
          servers: [{ ip: '113.250.57.28', port: 8000, type: 1 }],
        },
        authToken: 1234,
      };
    },
    async end() {},
  };
}

function makeSession(options: { media?: 'audio' | 'video'; videoEncoder?: CallVideoEncoder } = {}) {
  const timers = new FakeTimers();
  const transport = new FakeTransport();
  const signaling = fakeSignaling();
  const session = new CallSession({
    selfUin: '1707889225',
    selfUid: 'u_self',
    peerUin: '2863253201',
    peerUid: 'u_peer',
    media: options.media,
    signaling,
    transport,
    codec: new FakeCodec(),
    videoEncoder: options.videoEncoder,
    timers,
  });
  const states: CallState[] = [];
  session.onStateChange((s) => states.push(s.state));
  return { session, timers, transport, signaling, states };
}

function notifyPacket(event: number, peer = 2863253201): Uint8Array {
  const info = new Uint8Array([...pbVarint(1, peer), ...pbVarint(3, event)]);
  const body = new Uint8Array([...pbVarint(1, 1), ...pbBytes(2, info), ...pbVarint(3, 0)]);
  const head = buildGcsHead({
    roomId: 777n,
    selfUin: 1707889225,
    sessionTs: 555,
    typeId: 0x6241,
    bodyType: GcsBodyType.notifyPush,
  });
  return buildGcsPacket(head, body);
}

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

/** 拼一个视频分片（带 20 字节 sub-header + Annex B）。 */
function videoPacket(params: {
  gidx: number;
  pkgIdx: number;
  totalPkg: number;
  chunk: Uint8Array;
  subType?: number;
}): Uint8Array {
  const subType = params.subType ?? VideoSubType.max;
  const out = new Uint8Array(AUDIO_HEADER_LEN + 6 + VIDEO_EXT_LEN + params.chunk.length);
  out[0] = AUDIO_STX;
  out[1] = (out.length >> 8) & 0xff;
  out[2] = out.length & 0xff;
  out[3] = subType;
  out[13] = 0x6f;
  out[AUDIO_HEADER_LEN] = params.pkgIdx;
  out[AUDIO_HEADER_LEN + 1] = params.totalPkg;
  out[AUDIO_HEADER_LEN + 3] = 0x0b;
  out[AUDIO_HEADER_LEN + 4] = params.gidx;
  out[AUDIO_HEADER_LEN + 5] = 1;
  // 扩展 `03 03 00`（与真实客户端一致）。
  out[AUDIO_HEADER_LEN + 6] = VIDEO_EXT_LEN;
  out[AUDIO_HEADER_LEN + 7] = VIDEO_EXT_TYPE;
  out[AUDIO_HEADER_LEN + 8] = 0x00;
  out.set(params.chunk, AUDIO_HEADER_LEN + 6 + VIDEO_EXT_LEN);
  return out;
}

/** 十六进制串 → 字节。 */
function hexBytes(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 把会话推进到 connected。 */
async function connect(ctx: ReturnType<typeof makeSession>): Promise<void> {
  await ctx.session.start();
  ctx.transport.deliver(authRspPacket());
  ctx.transport.deliver(notifyPacket(CallEvent.dataChange));
}

// ─────────────────────────── 用例 ───────────────────────────

describe('视频通话信令', () => {
  it('发起视频通话时把 media 透给信令层', async () => {
    const ctx = makeSession({ media: 'video' });
    await ctx.session.start();
    expect(ctx.signaling.startedWith).toEqual([expect.objectContaining({ media: 'video' })]);
  });

  it('默认仍是语音', async () => {
    const ctx = makeSession();
    await ctx.session.start();
    expect(ctx.signaling.startedWith).toEqual([expect.objectContaining({ media: 'audio' })]);
  });
});

describe('接收视频', () => {
  it('分片组齐后回调收到 H.265 裸流', async () => {
    const ctx = makeSession();
    await connect(ctx);

    const frames: VideoFramePayload[] = [];
    ctx.session.onVideo((f) => frames.push(f));

    // 20 字节 sub-header（首字节 0x14）+ 起始码 + IDR（NAL 类型 19 → 0x26）。
    const sub = new Uint8Array(20);
    sub[0] = 20;
    const body = new Uint8Array([0, 0, 0, 1, 0x26, 0x01, 0xaf, 0xe0]);
    const whole = new Uint8Array(sub.length + body.length);
    whole.set(sub, 0);
    whole.set(body, sub.length);

    ctx.transport.deliver(
      videoPacket({ gidx: 0, pkgIdx: 0, totalPkg: 2, chunk: whole.subarray(0, 14) }),
    );
    expect(frames).toHaveLength(0);
    ctx.transport.deliver(
      videoPacket({ gidx: 0, pkgIdx: 1, totalPkg: 2, chunk: whole.subarray(14) }),
    );

    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.gidx).toBe(0);
    expect(frame.frameIndex).toBe(0);
    expect(frame.isKeyframe).toBe(true);
    expect(frame.hevc).not.toBeNull();
    expect([...frame.hevc!]).toEqual([...body]);
  });

  it('收到视频后快照里 videoReceiving 变 true', async () => {
    const ctx = makeSession();
    await connect(ctx);
    expect(ctx.session.snapshot().videoReceiving).toBe(false);

    const whole = new Uint8Array(26);
    whole[0] = 20;
    whole.set([0, 0, 0, 1, 0x40, 0x01], 20);
    ctx.transport.deliver(videoPacket({ gidx: 0, pkgIdx: 0, totalPkg: 1, chunk: whole }));

    const snapshot = ctx.session.snapshot();
    expect(snapshot.videoReceiving).toBe(true);
    expect(snapshot.receivedVideoFrames).toBe(1);
  });

  it('视频包不会再被当成音频静默丢弃', async () => {
    const ctx = makeSession();
    await connect(ctx);
    const before = ctx.session.snapshot().receivedFrames;

    const whole = new Uint8Array(26);
    whole[0] = 20;
    whole.set([0, 0, 0, 1, 0x40, 0x01], 20);
    ctx.transport.deliver(videoPacket({ gidx: 5, pkgIdx: 0, totalPkg: 1, chunk: whole }));

    // 音频计数不该被视频包污染。
    expect(ctx.session.snapshot().receivedFrames).toBe(before);
    expect(ctx.session.snapshot().receivedVideoFrames).toBe(1);
  });

  it('小画面 / 屏幕共享子类型也认', async () => {
    const ctx = makeSession();
    await connect(ctx);
    const frames: VideoFramePayload[] = [];
    ctx.session.onVideo((f) => frames.push(f));

    const whole = new Uint8Array(26);
    whole[0] = 20;
    whole.set([0, 0, 0, 1, 0x40, 0x01], 20);
    ctx.transport.deliver(
      videoPacket({ gidx: 0, pkgIdx: 0, totalPkg: 1, chunk: whole, subType: VideoSubType.screen }),
    );
    expect(frames).toHaveLength(1);
  });

  /**
   * 回归：关键帧要能读出分辨率。
   *
   * 真实 SPS 来自 2026-10-25 抓包（Windows QQ 发的 640×360 Main）。早先 RBSP
   * 起点按 12 字节跳（少算了 `sps_video_parameter_set_id` 那 1 字节），读出来是
   * `chroma=0 / w=0 / h=1`，`readHevcInfo` 永远返回 null —— 界面拿不到分辨率。
   */
  it('从真实关键帧的 SPS 读出 640×360', async () => {
    const ctx = makeSession();
    await connect(ctx);

    // VPS + SPS + PPS + IDR_W_RADL，SPS 用的是抓包原文。
    const annexb = hexBytes(
      '0000000140010c01' +
        '00000001420101016000000300900000030000030096a005020169659aa4932e4020' +
        '000000014401c172b0' +
        '000000012601afe0',
    );
    const whole = new Uint8Array(20 + annexb.length);
    whole[0] = 20;
    whole.set(annexb, 20);

    ctx.transport.deliver(videoPacket({ gidx: 0, pkgIdx: 0, totalPkg: 1, chunk: whole }));
    expect(ctx.session.snapshot().videoInfo).toEqual({
      width: 640,
      height: 360,
      profile: 1,
      codec: 'hevc',
    });
  });

  it('控制包是周期公告，重复收到不翻转状态', async () => {
    // 2026-10-25 真机抓包：一方 14 秒内发了 316 个控制包（每秒 20+）。
    // 早先按「收到即取反」实现，界面会每秒闪 20 次。
    const ctx = makeSession();
    await connect(ctx);
    expect(ctx.session.snapshot().videoReceiving).toBe(false);

    ctx.transport.deliver(buildVideoControl({ sessionTs: 1, tick: 2 }));
    expect(ctx.session.snapshot().videoReceiving).toBe(true);

    // 再来 30 条，状态必须稳住。
    for (let i = 0; i < 30; i++) {
      ctx.transport.deliver(buildVideoControl({ sessionTs: 1, tick: 3 + i }));
      expect(ctx.session.snapshot().videoReceiving).toBe(true);
    }
  });

  it('控制包彻底停了之后由看门狗收敛为已关闭', async () => {
    const ctx = makeSession();
    await connect(ctx);
    ctx.transport.deliver(buildVideoControl({ sessionTs: 1, tick: 2 }));
    expect(ctx.session.snapshot().videoReceiving).toBe(true);

    // 超过 VIDEO_SILENCE_MS（3 秒）没有任何控制包 / 视频包。
    await ctx.timers.advanceAsync(4000);
    expect(ctx.session.snapshot().videoReceiving).toBe(false);
  });

  it('保活包被忽略，不影响任何计数', async () => {
    const ctx = makeSession();
    await connect(ctx);
    const before = ctx.session.snapshot();
    ctx.transport.deliver(buildVideoKeepalive({ sessionTs: 1, tick: 2 }));
    const after = ctx.session.snapshot();
    expect(after.receivedVideoFrames).toBe(before.receivedVideoFrames);
    expect(after.videoReceiving).toBe(before.videoReceiving);
  });
});

describe('发送视频', () => {
  it('开摄像头时连发两个空体控制包', async () => {
    const ctx = makeSession({ media: 'video' });
    await connect(ctx);

    ctx.session.setCamera(true);
    const controls = ctx.transport.media(VIDEO_CTRL_SUB_TYPE);
    expect(controls).toHaveLength(2);
    // 两条必须逐字节相同（协议里没有开关位）。
    expect([...controls[0]!]).toEqual([...controls[1]!]);
    expect(controls[0]!).toHaveLength(17);
  });

  it('关摄像头发的也是同一条控制包', async () => {
    const ctx = makeSession({ media: 'video' });
    await connect(ctx);
    ctx.session.setCamera(true);
    ctx.transport.sent.length = 0;

    ctx.session.setCamera(false);
    const controls = ctx.transport.media(VIDEO_CTRL_SUB_TYPE);
    expect(controls).toHaveLength(2);
    expect(controls[0]!).toHaveLength(17);
  });

  it('视频通话接通即自动开摄像头（QQ 的默认行为）', async () => {
    const ctx = makeSession({ media: 'video' });
    await connect(ctx);
    // 接通那一刻就应该是「在发视频」，不需要用户再点一次。
    expect(ctx.session.snapshot().videoSending).toBe(true);
  });

  it('语音通话接通不会自动开摄像头', async () => {
    const ctx = makeSession();
    await connect(ctx);
    expect(ctx.session.snapshot().videoSending).toBe(false);
  });

  /**
   * 回归：开摄像头必须在 GCS 上公告视频参数（`bt=77`）。
   *
   * 2026-10-26 QQ 本体抓包实测：对端开始发视频后会在 GCS 推 24 字节的视频参数，
   * 之后每 2 秒重发。只发 `subType=4` 控制包而不发这条时，对端不知道本端开了
   * 摄像头 —— 这正是「WeQ 开摄像头，手机和电脑都看不到」的成因。
   */
  it('视频通话接通时公告视频参数（bt=77），规格与编码器一致', async () => {
    const encoder = new FakeVideoEncoder(1);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);

    const pushes = ctx.transport.sent
      .filter((s) => s.data[0] === GCS_STX)
      .map((s) => parseGcsPacket(s.data))
      .filter((p) => p?.bodyType === GcsBodyType.videoParamPush);
    expect(pushes.length).toBeGreaterThan(0);
    // FakeVideoEncoder 声明 640×360 / 15 fps / 400 kbps：
    //   宽 640 = 80 05，高 360 = e8 02，码率 400 = 90 03。
    expect([...pushes[0]!.body]).toEqual([
      0x12, 0x25, 0x10, 0xa2, 0x02, 0x18, 0x01, 0x22, 0x1e, 0x08, 0x0f, 0x10, 0x01, 0x18, 0x80,
      0x05, 0x20, 0xe8, 0x02, 0x28, 0x90, 0x03, 0x30, 0x00,
    ]);
  });

  it('公告每 2 秒重发一次（对端据此判断本端还在发视频）', async () => {
    const encoder = new FakeVideoEncoder(1);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    const count = () =>
      ctx.transport.sent.filter(
        (s) =>
          s.data[0] === GCS_STX && parseGcsPacket(s.data)?.bodyType === GcsBodyType.videoParamPush,
      ).length;
    const first = count();
    await ctx.timers.advanceAsync(2100);
    expect(count()).toBeGreaterThan(first);
  });

  it('关摄像头后停止公告视频参数', async () => {
    const encoder = new FakeVideoEncoder(1);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    ctx.session.setCamera(false);
    ctx.transport.reset();

    await ctx.timers.advanceAsync(5000);

    const pushes = ctx.transport.sent.filter(
      (s) =>
        s.data[0] === GCS_STX && parseGcsPacket(s.data)?.bodyType === GcsBodyType.videoParamPush,
    );
    expect(pushes).toHaveLength(0);
  });

  it('快照里 videoSending 跟着切换', async () => {
    const ctx = makeSession({ media: 'video' });
    await connect(ctx);
    // 接通即开，先关掉再验证开关。
    ctx.session.setCamera(false);
    expect(ctx.session.snapshot().videoSending).toBe(false);
    ctx.session.setCamera(true);
    expect(ctx.session.snapshot().videoSending).toBe(true);
    ctx.session.setCamera(false);
    expect(ctx.session.snapshot().videoSending).toBe(false);
  });

  it('开摄像头后编码器的帧被切成视频包发出去', async () => {
    const encoder = new FakeVideoEncoder(1);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);

    ctx.session.setCamera(true);
    // 视频循环是 10 ms 一拍；编码是 async，要等微任务。
    await ctx.timers.advanceAsync(30);

    const videos = ctx.transport.media(VideoSubType.max);
    expect(videos.length).toBeGreaterThan(0);

    // 用接收侧的组装器把发出去的包拼回来，验证「发得出、收得回」同构。
    const assembler = new VideoFrameAssembler();
    let frame = null;
    for (const packet of videos) {
      frame = assembler.push(parseVideoPacket(packet)!, 0) ?? frame;
    }
    expect(frame).not.toBeNull();
    // 20 字节 sub-header，之后是起始码开头的裸流。
    expect(frame!.frameData[0]).toBe(20);
    expect([...frame!.frameData.subarray(20, 24)]).toEqual([0, 0, 0, 1]);
    expect([...frame!.frameData.subarray(24, 26)]).toEqual([0x40, 0x01]);
  });

  /**
   * 回归：发送侧必须用 16 位帧序号。
   *
   * 早先 `gidx = videoFrameIndex & 0xff`、`fidx` 恒 1，第 256 帧包头从
   * `g=255/f=1` 跳回 `g=0/f=1`，帧序号倒退 —— 对端按序号判连续性时会当成乱序。
   */
  it('跨 256 帧后 fidx 递增，帧序号不回退', async () => {
    const encoder = new FakeVideoEncoder(300);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    ctx.session.setCamera(true);
    await ctx.timers.advanceAsync(5000);

    // 只看每个视频帧的首个分片（pkgIdx === 0），按发送顺序取帧序号。
    const seen: Array<{ gidx: number; fidx: number }> = [];
    for (const packet of ctx.transport.media(VideoSubType.max)) {
      const parsed = parseVideoPacket(packet)!;
      if (parsed.rtp.pkgIdx !== 0) continue;
      seen.push({ gidx: parsed.rtp.gidx, fidx: parsed.rtp.fidx });
    }
    expect(seen.length).toBeGreaterThan(256);

    const indexes = seen.map((s) => videoFrameIndex(s.gidx, s.fidx));
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]!).toBe(indexes[i - 1]! + 1);
    }
    // 第 256 帧必须已经换到 fidx=2，而不是把 gidx 绕回 0。
    expect(seen[255]).toEqual({ gidx: 255, fidx: 1 });
    expect(seen[256]).toEqual({ gidx: 0, fidx: 2 });
  });

  it('sub-header 按 c2s 方向填（[2]=0x00、[3]=0x06、PTS 递增）', async () => {
    const encoder = new FakeVideoEncoder(2);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    ctx.session.setCamera(true);
    await ctx.timers.advanceAsync(40);

    const videos = ctx.transport.media(VideoSubType.max);
    expect(videos.length).toBeGreaterThan(0);
    const sh = parseVideoPacket(videos[0]!)!.payload;
    // 首字节是 sub-header 长度 20，紧跟 [1] 帧序号、[2] 方向、[3] 常量。
    expect(sh[0]).toBe(20);
    expect(sh[2]).toBe(0x00); // c2s，不是 0x03
    expect(sh[3]).toBe(0x06); // 首帧也是 06
    // [8:12] 是距接通的毫秒数（首帧可能为 0，至少不能是 Date.now() 量级）。
    const pts = new DataView(sh.buffer, sh.byteOffset + 8, 4).getUint32(0);
    expect(pts).toBeLessThan(60_000);
    // [12:16] 是接通时定下的会话基准 tick（非 0）。
    const base = new DataView(sh.buffer, sh.byteOffset + 12, 4).getUint32(0);
    expect(base).toBeGreaterThan(0);
  });

  it('关摄像头后不再发视频包', async () => {
    const encoder = new FakeVideoEncoder(100);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    ctx.session.setCamera(true);
    await ctx.timers.advanceAsync(50);
    const before = ctx.transport.media(VideoSubType.max).length;
    expect(before).toBeGreaterThan(0);

    ctx.session.setCamera(false);
    await ctx.timers.advanceAsync(200);
    expect(ctx.transport.media(VideoSubType.max).length).toBe(before);
  });

  it('没接通时开摄像头是空操作', async () => {
    const ctx = makeSession({ media: 'video' });
    await ctx.session.start();
    ctx.session.setCamera(true);
    expect(ctx.transport.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(0);
    expect(ctx.session.snapshot().videoSending).toBe(false);
  });

  it('挂断时关掉编码器并清空组装器', async () => {
    const encoder = new FakeVideoEncoder(10);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    ctx.session.setCamera(true);
    await ctx.timers.advanceAsync(20);

    await ctx.session.hangup();
    expect(encoder.closed).toBe(true);
    expect(ctx.session.snapshot().videoSending).toBe(false);
  });
});

describe('媒体路径（中继 / 直连）', () => {
  const SERVER_IP = '113.250.57.28';
  const PEER_IP = '240e:399:f9d:3f10:7167:3709:7894:4f2';

  it('没学到对端端口时只发服务端', async () => {
    const encoder = new FakeVideoEncoder(1000);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    ctx.transport.reset();
    await ctx.timers.advanceAsync(20);

    const videos = ctx.transport.media(VideoSubType.max);
    expect(videos.length).toBeGreaterThan(0);
    expect(ctx.transport.mediaTo(SERVER_IP, VideoSubType.max).length).toBe(videos.length);
  });

  it('学到对端地址后进入探测期：两份都发', async () => {
    const encoder = new FakeVideoEncoder(1000);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    await ctx.timers.advanceAsync(20);

    // 对端从直连地址发来一个媒体包 → 学到端口。
    const whole = new Uint8Array(26);
    whole[0] = 20;
    whole.set([0, 0, 0, 1, 0x40, 0x01], 20);
    ctx.transport.deliverFrom(videoPacket({ gidx: 0, pkgIdx: 0, totalPkg: 1, chunk: whole }), {
      address: PEER_IP,
      port: 47708,
    });
    ctx.transport.reset();
    await ctx.timers.advanceAsync(20);

    // 探测期内：服务端一份 + P2P 一份。
    expect(ctx.transport.mediaTo(SERVER_IP, VideoSubType.max).length).toBeGreaterThan(0);
    expect(ctx.transport.mediaTo(PEER_IP, VideoSubType.max).length).toBeGreaterThan(0);
  });

  it('探测期结束后只发 P2P', async () => {
    const encoder = new FakeVideoEncoder(10000);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    const whole = new Uint8Array(26);
    whole[0] = 20;
    whole.set([0, 0, 0, 1, 0x40, 0x01], 20);
    ctx.transport.deliverFrom(videoPacket({ gidx: 0, pkgIdx: 0, totalPkg: 1, chunk: whole }), {
      address: PEER_IP,
      port: 47708,
    });
    // 探测期 1 秒；期间对端持续有媒体包，避免被判定为直连静默。
    for (let i = 0; i < 12; i++) {
      await ctx.timers.advanceAsync(100);
      ctx.transport.deliverFrom(
        videoPacket({ gidx: i + 1, pkgIdx: 0, totalPkg: 1, chunk: whole }),
        { address: PEER_IP, port: 47708 },
      );
    }
    ctx.transport.reset();
    await ctx.timers.advanceAsync(50);

    expect(ctx.transport.mediaTo(SERVER_IP, VideoSubType.max)).toHaveLength(0);
    expect(ctx.transport.mediaTo(PEER_IP, VideoSubType.max).length).toBeGreaterThan(0);
  });

  it('直连静默超时后回落服务端', async () => {
    const encoder = new FakeVideoEncoder(10000);
    const ctx = makeSession({ media: 'video', videoEncoder: encoder });
    await connect(ctx);
    const whole = new Uint8Array(26);
    whole[0] = 20;
    whole.set([0, 0, 0, 1, 0x40, 0x01], 20);
    ctx.transport.deliverFrom(videoPacket({ gidx: 0, pkgIdx: 0, totalPkg: 1, chunk: whole }), {
      address: PEER_IP,
      port: 47708,
    });
    // 撑过探测期。
    for (let i = 0; i < 12; i++) {
      await ctx.timers.advanceAsync(100);
      ctx.transport.deliverFrom(
        videoPacket({ gidx: i + 1, pkgIdx: 0, totalPkg: 1, chunk: whole }),
        { address: PEER_IP, port: 47708 },
      );
    }
    ctx.transport.reset();
    // 之后对端彻底不再回包 → 看门狗应在 2 秒后回落。
    await ctx.timers.advanceAsync(4000);
    ctx.transport.reset();
    await ctx.timers.advanceAsync(50);

    expect(ctx.transport.mediaTo(SERVER_IP, VideoSubType.max).length).toBeGreaterThan(0);
  });

  it('保活包每拍两条：0x02 与 0x03 变体', async () => {
    const ctx = makeSession({ media: 'video' });
    await connect(ctx);
    ctx.transport.reset();
    await ctx.timers.advanceAsync(2100);

    const keepalives = ctx.transport.media(0x05);
    expect(keepalives.length).toBeGreaterThanOrEqual(2);
    const bodies = keepalives.map((p) => p[17]);
    expect(bodies).toContain(0x02);
    expect(bodies).toContain(0x03);
  });
});
