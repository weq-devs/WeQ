/**
 * 语音通话会话：状态机 + 收发编排。
 *
 * 一次通话的三条腿：
 *
 *   1. **信令**（TCP，借 SSO）：开房、邀请、挂断。走 `@weq/protocol` 的
 *      `startC2CCall` / `endC2CCall`，只需要已登记的 pid。
 *   2. **控制面**（UDP → GCS）：认证、心跳、状态上报、房间事件。
 *   3. **媒体**（UDP → GCS）：Opus 帧收发，20 ms 一帧。
 *
 * relay 通道（`0x02`）是补充路径：服务端在 UDP 直连不通时用它中继，正常链路下
 * 注册了就行，不依赖它送音频。
 *
 * 这个模块**不碰 Electron、不碰 native**：UDP 用 {@link UdpTransport}，编解码用
 * {@link CallAudioCodec}，两者由主进程注入。这样状态机可以在单测里用假时钟和
 * 假 socket 跑完整个生命周期。
 *
 * ⚠️ 只做主动发起。来电推送由 QQ 本体的 AVSDK 消费，我们借凭据发包，收不到那条
 * push，所以没有「被动接听」这条路径。
 */

import {
  AUDIO_STX,
  AudioSubType,
  type AudioFrame,
  type CallRoom,
  CallEvent,
  type CallServer,
  DEFAULT_CAPABILITIES,
  FRAME_SAMPLES,
  GCS_STX,
  GCS_TYPE_ID_BASE,
  GcsBodyType,
  OPUS_SILENCE,
  RELAY_CHANNEL_BASE,
  RELAY_STX,
  buildAudioFrame,
  buildCodecInitFrame,
  buildFecContainer,
  buildGcsAck,
  buildGcsAuth,
  buildGcsHeartbeat,
  buildGcsLogout,
  buildQfbRequest,
  buildQfbResponse,
  buildRelayGetIn,
  buildRelayKeepalive,
  buildStatusReport,
  parseAudioFrame,
  parseAudioHeader,
  parseCallEvent,
  parseFecContainer,
  parseGcsPacket,
  parseQfb,
  rsEncode,
  endC2CCall,
  startC2CCall,
} from '@weq/protocol';
import type { Logger } from '../common/logger';

// ─────────────────────────── 状态 ───────────────────────────

export type CallState =
  /** 还没开始 / 已彻底结束。 */
  | 'idle'
  /** 开房 + 邀请已发出，等对端响应。 */
  | 'calling'
  /** 对端正在振铃（服务端回了 event=4）。 */
  | 'ringing'
  /** 对端已进入房间但还没开始送音频。 */
  | 'connecting'
  /** 双向音频已通。 */
  | 'connected'
  /** 正在挂断。 */
  | 'ending'
  /** 已结束（正常挂断）。 */
  | 'ended'
  /** 异常结束（失败 / 超时 / 被踢）。 */
  | 'failed';

/** 挂断原因，会透给界面。 */
export type CallEndReason =
  | 'hangup'
  | 'peer_hangup'
  | 'peer_refused'
  | 'timeout'
  | 'connect_fail'
  | 'kicked'
  | 'error';

export interface CallSnapshot {
  state: CallState;
  /** 房间号（十进制串，给日志与界面用）。 */
  roomId: string | null;
  peerUin: string;
  peerUid: string;
  /** 通话开始时刻（毫秒）。 */
  startedAt: number | null;
  /** 接通时刻；未接通为 null。 */
  connectedAt: number | null;
  /** 结束时原因。 */
  endReason: CallEndReason | null;
  /** 最近一次错误。 */
  lastError: string | null;
  /** 收发的音频帧计数（调试 / 界面波形用）。 */
  sentFrames: number;
  receivedFrames: number;
}

// ─────────────────────────── 依赖注入 ───────────────────────────

/** 一个 UDP 套接字的最小表面（真实实现是 `node:dgram`）。 */
export interface UdpTransport {
  /** 绑定本地端口（0 = 随机）。 */
  bind(): Promise<void>;
  send(data: Uint8Array, port: number, address: string): void;
  close(): void;
  /** 收到一个包。 */
  onMessage(handler: (data: Uint8Array, from: { address: string; port: number }) => void): void;
  /** 套接字错误。 */
  onError(handler: (error: Error) => void): void;
}

/** 编解码能力。native 侧实现；测试里可以换成恒等变换。 */
export interface CallAudioCodec {
  open(): Promise<void>;
  /** 640 字节 PCM → Opus。 */
  encode(pcm: Uint8Array): Promise<Uint8Array>;
  /** Opus → 640 字节 PCM。 */
  decode(opus: Uint8Array): Promise<Uint8Array>;
  close(): void;
}

/** 借凭据发信令的最小表面（`@weq/protocol` 的实现直接满足）。 */
export interface CallSignaling {
  start(params: {
    selfUid: string;
    peerUid: string;
  }): Promise<{ room: CallRoom; authToken: number }>;
  end(params: { selfUid: string; roomId: bigint; relationId: number }): Promise<void>;
}

/** 定时器，单测里换成手动推进的实现。 */
export interface CallTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realTimers: CallTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** 监听器。 */
export type CallListener = (snapshot: CallSnapshot) => void;
/** 收到一帧对端音频（已解码成 PCM）。 */
export type CallAudioListener = (pcm: Uint8Array, at: number) => void;

export interface CallSessionOptions {
  selfUin: string;
  selfUid: string;
  peerUin: string;
  peerUid: string;
  signaling: CallSignaling;
  transport: UdpTransport;
  codec: CallAudioCodec;
  timers?: CallTimers;
  logger?: Logger;
}

// ─────────────────────────── 常量 ───────────────────────────

/** 心跳周期：GCS 按 2 秒判活，缺两拍就拆房间。 */
const HEARTBEAT_MS = 2000;
/** 状态上报周期：不报会被判掉线。 */
const STATUS_REPORT_MS = 2000;
/** 质量反馈周期。 */
const QFB_MS = 2000;
/** 中继保活周期。 */
const RELAY_KEEPALIVE_MS = 5000;
/** 一帧音频 20 ms。 */
const FRAME_MS = 20;
/** 从发起到对端有响应的上限。 */
const RING_TIMEOUT_MS = 60_000;
/** 已进入房间但迟迟不送音频的上限。 */
const CONNECT_TIMEOUT_MS = 30_000;
/** 登出包重发次数（UDP 无连接，单发丢包会让对端停在通话中）。 */
const LOGOUT_REPEATS = 5;

/** 每 4 帧音频一组 RS 编码。 */
const FEC_GROUP = 4;

// ─────────────────────────── 会话 ───────────────────────────

export class CallSession {
  private readonly opts: CallSessionOptions;
  private readonly timers: CallTimers;
  private readonly log: Logger | undefined;

  private state: CallState = 'idle';
  private room: CallRoom | null = null;
  private authToken = 0;
  private relationId = 0;
  /** 认证回包里的会话时间戳，之后所有包的 head.f3 都用它。 */
  private sessionTs = 0;
  /** 全局递增的 typeId。 */
  private typeId = GCS_TYPE_ID_BASE;

  private gcs: CallServer | null = null;
  private relays: CallServer[] = [];

  private startedAt: number | null = null;
  private connectedAt: number | null = null;
  private endReason: CallEndReason | null = null;
  private lastError: string | null = null;
  private sentFrames = 0;
  private receivedFrames = 0;

  // 定时器
  private heartbeatTimer: unknown = null;
  private statusTimer: unknown = null;
  private qfbTimer: unknown = null;
  private relayTimer: unknown = null;
  private audioTimer: unknown = null;
  private ringTimer: unknown = null;
  private connectTimer: unknown = null;

  // 音频
  private readonly sendQueue: Uint8Array[] = [];
  private audioSeq = 0;
  private frameCounter = 0;
  private sampleBase = 0;
  private statusReportSeq = 0;
  private qfbSeq = 0;
  /** 上一组音频的 RS 校验行 + 帧长 + 锚帧 tick。 */
  private fecParity: Uint8Array[] | null = null;
  private fecPaySize = 0;
  private fecGroupTick = 0;
  private fecGlobalCnt = 0;
  private fecSubSeq = 1000 + Math.floor(Math.random() * 9000);

  /** 对方最后一个包的 tick（质量反馈的 tsStart）。 */
  private lastPeerTick = 0;

  private readonly listeners = new Set<CallListener>();
  private readonly audioListeners = new Set<CallAudioListener>();

  constructor(options: CallSessionOptions) {
    this.opts = options;
    this.timers = options.timers ?? realTimers;
    this.log = options.logger;
  }

  // ── 对外 ──

  snapshot(): CallSnapshot {
    return {
      state: this.state,
      roomId: this.room?.roomId.toString() ?? null,
      peerUin: this.opts.peerUin,
      peerUid: this.opts.peerUid,
      startedAt: this.startedAt,
      connectedAt: this.connectedAt,
      endReason: this.endReason,
      lastError: this.lastError,
      sentFrames: this.sentFrames,
      receivedFrames: this.receivedFrames,
    };
  }

  onStateChange(listener: CallListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAudio(listener: CallAudioListener): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  /** 把一帧 640 字节 PCM 排进发送队列。队列空的时候发静音帧。 */
  pushAudio(pcm: Uint8Array): void {
    if (pcm.length !== FRAME_SAMPLES * 2) return;
    if (this.state !== 'connected') return;
    // 最多压 5 帧（100 ms）：落后太多说明前端卡了，丢掉旧的保持实时。
    if (this.sendQueue.length > 5) this.sendQueue.shift();
    this.sendQueue.push(pcm);
  }

  /** 发起通话。 */
  async start(): Promise<CallSnapshot> {
    if (this.state !== 'idle') throw new Error(`通话已在 ${this.state} 状态`);
    this.startedAt = this.timers.now();

    try {
      // 1. 信令
      const { room, authToken } = await this.opts.signaling.start({
        selfUid: this.opts.selfUid,
        peerUid: this.opts.peerUid,
      });
      this.room = room;
      this.authToken = authToken;
      this.relationId = room.relationId;
      this.pickServers(room.servers);
      if (!this.gcs) throw new Error('服务端没有返回可用的服务器地址');

      // 2. 编解码器
      await this.opts.codec.open();

      // 3. UDP
      this.opts.transport.onMessage((data, from) => this.handlePacket(data, from));
      this.opts.transport.onError((error) => this.fail(error.message));
      await this.opts.transport.bind();

      // 4. 握手
      this.sendAuth();
      this.sendRelayGetIn();
      this.startHeartbeat();
      this.startStatusReport();
      this.sendCodecInit();

      this.state = 'calling';
      this.emit();
      this.armRingTimeout();
      return this.snapshot();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return this.snapshot();
    }
  }

  /** 主动挂断。 */
  async hangup(reason: CallEndReason = 'hangup'): Promise<void> {
    if (this.state === 'idle' || this.state === 'ended' || this.state === 'failed') return;
    this.state = 'ending';
    this.emit();
    this.endReason = reason;
    await this.teardown(reason);
  }

  // ── 服务器选择 ──

  /**
   * 服务端给的是「同一台机器的多个地址」：type=1 是 GCS（控制面 + 音频），
   * type=2 是中继。IPv4 与 IPv6 各一套，这里只用 IPv4（套接字是 udp4）。
   */
  private pickServers(servers: CallServer[]): void {
    const gcs = servers.find((s) => s.type === 1);
    this.gcs = gcs ?? servers.find((s) => s.type === 2) ?? null;
    this.relays = servers.filter((s) => s.type === 2).slice(0, 2);
  }

  // ── 发包 ──

  private send(data: Uint8Array): void {
    if (!this.gcs) return;
    this.opts.transport.send(data, this.gcs.port, this.gcs.ip);
  }

  private sendTo(data: Uint8Array, server: CallServer): void {
    this.opts.transport.send(data, server.port, server.ip);
  }

  private nextTypeId(): number {
    return ++this.typeId;
  }

  private tick(): number {
    return this.timers.now() >>> 0;
  }

  private sendAuth(): void {
    if (!this.room) return;
    const packet = buildGcsAuth({
      roomId: this.room.roomId,
      selfUin: Number(this.opts.selfUin),
      typeId: GCS_TYPE_ID_BASE,
      authKey: this.room.authKey,
      capabilities: DEFAULT_CAPABILITIES,
    });
    // 真实客户端连发两次；服务端对重复认证是幂等的。
    this.send(packet);
    this.send(packet);
  }

  private sendRelayGetIn(): void {
    if (!this.room) return;
    for (const [index, server] of this.relays.entries()) {
      this.sendTo(
        buildRelayGetIn({
          roomId: this.room.roomId,
          selfUin: Number(this.opts.selfUin),
          channelId: RELAY_CHANNEL_BASE + index,
          authToken: this.authToken,
        }),
        server,
      );
    }
  }

  /** 编码器初始化帧：声明本端用 Opus。 */
  private sendCodecInit(): void {
    this.send(
      buildCodecInitFrame({
        sessionTs: this.sessionTs,
        tick: this.tick(),
      }),
    );
    // 顺带发几帧静音，让对端的解码器立刻有数据可吃。
    for (let i = 0; i < 4; i++) this.sendSilenceFrame();
  }

  private sendSilenceFrame(): void {
    if (!this.room) return;
    this.audioSeq++;
    this.frameCounter++;
    const sampleCounter = this.sampleBase + this.frameCounter * FRAME_SAMPLES;
    const { packet } = buildAudioFrame({
      seq: this.audioSeq,
      sessionTs: this.sessionTs,
      tick: this.tick(),
      sampleCounter,
      frameCounter: this.frameCounter,
      opus: OPUS_SILENCE,
    });
    this.send(packet);
    this.sentFrames++;
  }

  // ── 定时器 ──

  private startHeartbeat(): void {
    const beat = () => {
      if (!this.room) return;
      this.send(
        buildGcsHeartbeat({
          roomId: this.room.roomId,
          selfUin: Number(this.opts.selfUin),
          typeId: this.nextTypeId(),
          sessionTs: this.sessionTs,
          tick: this.tick(),
        }),
      );
    };
    beat();
    this.heartbeatTimer = this.timers.setInterval(beat, HEARTBEAT_MS);
  }

  private startStatusReport(): void {
    this.statusTimer = this.timers.setInterval(() => {
      if (!this.room) return;
      this.statusReportSeq++;
      this.send(
        buildStatusReport({
          roomId: this.room.roomId,
          selfUin: Number(this.opts.selfUin),
          sessionTs: this.sessionTs,
          typeId: this.nextTypeId(),
          sendPackets: this.sentFrames,
          recvPackets: this.receivedFrames,
          sendBytes: this.sentFrames * 80,
          seq: this.statusReportSeq,
        }),
      );
    }, STATUS_REPORT_MS);
  }

  private startQfb(): void {
    this.qfbTimer = this.timers.setInterval(() => {
      if (!this.room) return;
      this.qfbSeq++;
      this.send(
        buildQfbRequest({
          seq: this.qfbSeq,
          sessionTs: this.sessionTs,
          tick: this.tick(),
          qfbSeq: this.qfbSeq,
          tsStart: this.lastPeerTick,
        }),
      );
    }, QFB_MS);
  }

  private startRelayKeepalive(): void {
    this.relayTimer = this.timers.setInterval(() => {
      if (!this.room) return;
      for (const [index, server] of this.relays.entries()) {
        this.sendTo(
          buildRelayKeepalive({
            roomId: this.room.roomId,
            selfUin: Number(this.opts.selfUin),
            channelId: RELAY_CHANNEL_BASE + index,
            authToken: this.authToken,
          }),
          server,
        );
      }
    }, RELAY_KEEPALIVE_MS);
  }

  /**
   * 20 ms 一拍的发送循环。
   *
   * 对齐到绝对时间（`startedAt + n × 20`），而不是「每次 setTimeout(20)」——
   * 后者会被事件循环的调度抖动越拖越慢，20 秒后就能差出好几帧，接收端的
   * jitter buffer 会当成网络抖动去补帧，听起来断续。
   *
   * 单次最多补 2 帧：落后更多说明本机卡了（GC / 休眠），追帧只会把一批音频
   * 瞬间砸过去，不如跳过这段间隙。
   */
  private startAudioLoop(): void {
    let anchor = this.timers.now();
    let emitted = 0;
    const MAX_BURST = 2;

    const pump = () => {
      if (this.state !== 'connected') return;
      const elapsed = this.timers.now() - anchor;
      const due = Math.floor(elapsed / FRAME_MS) + 1;
      let behind = due - emitted;
      if (behind > MAX_BURST) {
        anchor = this.timers.now() - emitted * FRAME_MS;
        behind = Math.floor((this.timers.now() - anchor) / FRAME_MS) + 1 - emitted;
      }
      let burst = 0;
      while (
        emitted < Math.floor((this.timers.now() - anchor) / FRAME_MS) + 1 &&
        burst < MAX_BURST
      ) {
        emitted++;
        burst++;
        void this.emitFrame();
      }
      const nextAt = anchor + emitted * FRAME_MS;
      const delay = Math.max(1, Math.min(18, Math.floor(nextAt - this.timers.now())));
      this.audioTimer = this.timers.setTimeout(pump, delay);
    };
    this.audioTimer = this.timers.setTimeout(pump, 0);
  }

  private async emitFrame(): Promise<void> {
    if (!this.room) return;
    const pcm = this.sendQueue.shift();
    let opus = OPUS_SILENCE;
    if (pcm) {
      try {
        opus = await this.opts.codec.encode(pcm);
      } catch (error) {
        this.log?.warn('编码一帧失败，改发静音', { error });
      }
    }

    this.audioSeq++;
    this.frameCounter++;
    const posInGroup = (this.frameCounter - 1) % FEC_GROUP;

    // 组内前 3 帧携带**上一组**的校验行；第 4 帧是锚帧。
    let fecContainer: Uint8Array | undefined;
    if (posInGroup < FEC_GROUP - 1 && this.fecParity) {
      this.fecGlobalCnt++;
      const cnt0 = this.fecGlobalCnt - 1;
      fecContainer = buildFecContainer({
        parity: this.fecParity[posInGroup]!,
        paySize: this.fecPaySize,
        rowIndex: posInGroup,
        globalCnt: this.fecGlobalCnt,
        groupTick: this.fecGroupTick,
        // 跳过每组锚帧的位置：1,2,3, 5,6,7, 9,10,11…
        globalFecIdx: cnt0 + Math.floor(cnt0 / (FEC_GROUP - 1)) + 1,
        fecSubSeq: this.fecSubSeq,
      });
    }

    const tick = this.tick();
    const sampleCounter = this.sampleBase + this.frameCounter * FRAME_SAMPLES;
    const { packet, rsfec } = buildAudioFrame({
      seq: this.audioSeq,
      sessionTs: this.sessionTs,
      tick,
      sampleCounter,
      frameCounter: this.frameCounter,
      opus,
      fecContainer,
    });
    this.send(packet);
    this.sentFrames++;

    // 组结束：对本组 4 帧做 RS 编码，校验行留给下一组。
    if (posInGroup === FEC_GROUP - 1) {
      const group = this.audioGroup;
      const maxLen = Math.max(...group.map((f) => f.length), 0);
      if (maxLen > 0) {
        this.fecParity = rsEncode(group, maxLen);
        this.fecPaySize = maxLen;
        this.fecGroupTick = tick;
      }
      this.audioGroup = [];
    } else {
      this.audioGroup.push(rsfec);
    }
  }

  /** 当前正在凑的这一组 RS 帧。 */
  private audioGroup: Uint8Array[] = [];

  // ── 收包 ──

  private handlePacket(data: Uint8Array, _from: { address: string; port: number }): void {
    if (data.length < 1) return;
    const stx = data[0];
    if (stx === GCS_STX) this.handleGcs(data);
    else if (stx === AUDIO_STX) this.handleAudio(data);
    else if (stx === RELAY_STX) this.handleRelay(data);
  }

  private handleGcs(data: Uint8Array): void {
    const packet = parseGcsPacket(data);
    if (!packet) return;

    // 认证回包里的会话时间戳，之后所有包都要带。
    if (packet.sessionTs !== 0) this.sessionTs = packet.sessionTs;

    switch (packet.bodyType) {
      case GcsBodyType.authRsp:
        this.handleAuthRsp();
        break;
      case GcsBodyType.notifyPush:
        this.handleCallEvent(packet.body, packet.typeId);
        break;
      case GcsBodyType.peerJoin:
        this.ackPush(packet.typeId, packet.bodyType, packet.body);
        break;
      default:
        // 其它推送类型一律回 ACK：不回的话服务端会重推。
        if (packet.bodyType % 2 === 1) this.ackPush(packet.typeId, packet.bodyType, packet.body);
        break;
    }
  }

  private handleAuthRsp(): void {
    // 认证成功即开始中继保活（中继注册先于认证发出去，服务端会缓存）。
    if (!this.relayTimer) this.startRelayKeepalive();
    this.log?.debug('GCS 认证成功', { roomId: this.room?.roomId.toString() });
  }

  private ackPush(typeId: number, bodyType: number, body: Uint8Array): void {
    if (!this.room) return;
    this.send(
      buildGcsAck({
        roomId: this.room.roomId,
        selfUin: Number(this.opts.selfUin),
        sessionTs: this.sessionTs,
        typeId,
        pushBodyType: bodyType,
        pushBody: body,
        authKey: this.room.authKey,
      }),
    );
  }

  /**
   * 房间事件。
   *
   * 事件号的含义（`CallEvent`）：
   *   4 = 振铃 → `ringing`
   *   2/3 = 已进入 / 已接受 → `connecting`
   *   10 = 对端开始送音频 → `connected`（这条才是真正的「接通」）
   *   7 = 对端挂断 / 5 连接失败 / 8 超时 / 9 被踢 → 结束
   */
  private handleCallEvent(body: Uint8Array, typeId: number): void {
    this.ackPush(typeId, GcsBodyType.notifyPush, body);
    const event = parseCallEvent(body);
    if (!event) return;
    this.log?.debug('房间事件', { kind: event.event, peer: event.peerUin, seq: event.seq });

    switch (event.event) {
      case CallEvent.ringing:
        if (this.state === 'calling') {
          this.state = 'ringing';
          this.emit();
        }
        break;
      case CallEvent.entered:
      case CallEvent.accepted:
        if (this.state === 'calling' || this.state === 'ringing') {
          this.state = 'connecting';
          this.emit();
          this.armConnectTimeout();
        }
        break;
      case CallEvent.dataChange:
        this.markConnected();
        break;
      case CallEvent.logout:
        void this.teardown('peer_hangup');
        break;
      case CallEvent.connectFail:
        void this.teardown('connect_fail');
        break;
      case CallEvent.timeout:
        void this.teardown('timeout');
        break;
      case CallEvent.kickOut:
        void this.teardown('kicked');
        break;
      default:
        // invited / refusedAlt 等不影响状态。
        break;
    }
  }

  private markConnected(): void {
    if (this.state === 'connected') return;
    this.clearTimer('connectTimer');
    this.state = 'connected';
    this.connectedAt = this.timers.now();
    // 样本计数器与 ssrc 基线在同一时刻定下来，二者必须同源。
    this.sampleBase = (this.tick() * 16) >>> 0;
    this.startQfb();
    this.startAudioLoop();
    this.emit();
  }

  private handleAudio(data: Uint8Array): void {
    const header = parseAudioHeader(data);
    if (!header) return;
    this.lastPeerTick = header.tick;

    if (header.subType === AudioSubType.qfb) {
      const qfb = parseQfb(data.subarray(17));
      if (qfb && qfb.type === 1) {
        this.send(
          buildQfbResponse({
            seq: this.qfbSeq,
            sessionTs: this.sessionTs,
            tick: this.tick(),
            qfbSeq: qfb.qfbSeq,
            echoTs: header.tick,
          }),
        );
      }
      return;
    }

    if (header.subType !== AudioSubType.audio) return;
    const frame = parseAudioFrame(data);
    if (!frame?.isOpus || frame.payload.length === 0) return;

    // 组内前 3 帧带的是上一组的校验行，这里不做恢复（服务端已保证 Jitter
    // Buffer 足够长），只负责把 FEC 容器从载荷里切掉。
    if (frame.version === 0x50) {
      parseFecContainer(data.subarray(17));
    }

    this.receivedFrames++;
    void this.deliverAudio(frame, header.subType);
  }

  private async deliverAudio(frame: AudioFrame, _subType: number): Promise<void> {
    try {
      const pcm = await this.opts.codec.decode(frame.payload);
      for (const listener of this.audioListeners) listener(pcm, this.timers.now());
    } catch (error) {
      this.log?.warn('解码一帧失败', { error });
    }
  }

  private handleRelay(data: Uint8Array): void {
    if (data.length < 7) return;
    const cmd = (data[5]! << 8) | data[6]!;
    // GET_IN 的应答（cmd=2）说明中继通道注册成功。
    if (cmd === 2) this.log?.debug('中继通道已注册');
  }

  // ── 超时 ──

  private armRingTimeout(): void {
    this.clearTimer('ringTimer');
    this.ringTimer = this.timers.setTimeout(() => {
      if (this.state === 'calling' || this.state === 'ringing') {
        void this.teardown('timeout');
      }
    }, RING_TIMEOUT_MS);
  }

  private armConnectTimeout(): void {
    this.clearTimer('connectTimer');
    this.connectTimer = this.timers.setTimeout(() => {
      if (this.state === 'connecting') void this.teardown('timeout');
    }, CONNECT_TIMEOUT_MS);
  }

  private clearTimer(name: 'ringTimer' | 'connectTimer'): void {
    const handle = this[name];
    if (handle !== null) {
      this.timers.clearTimeout(handle);
      this[name] = null;
    }
  }

  // ── 收尾 ──

  private fail(message: string): void {
    this.lastError = message;
    this.log?.error('通话失败', { error: message });
    void this.teardown('error');
  }

  /**
   * 拆掉会话。
   *
   * 顺序有讲究：**先**给 GCS 发 UDP 登出（重发 5 次），**再**发 MSF 登出。
   * 反过来中继不会拆连接，对端会一直停在「通话中」。
   */
  private async teardown(reason: CallEndReason): Promise<void> {
    if (this.state === 'ended' || this.state === 'failed') return;
    this.endReason = reason;

    this.stopTimers();

    if (this.room && reason !== 'error') {
      const logout = buildGcsLogout({
        roomId: this.room.roomId,
        selfUin: Number(this.opts.selfUin),
        sessionTs: this.sessionTs,
        typeId: this.nextTypeId(),
        authKey: this.room.authKey,
      });
      for (let i = 0; i < LOGOUT_REPEATS; i++) this.send(logout);

      try {
        await this.opts.signaling.end({
          selfUid: this.opts.selfUid,
          roomId: this.room.roomId,
          relationId: this.relationId,
        });
      } catch (error) {
        this.log?.warn('挂断信令失败', { error });
      }
    }

    this.opts.codec.close();
    this.opts.transport.close();
    this.sendQueue.length = 0;

    const wasConnected = this.connectedAt !== null;
    this.state = reason === 'error' ? 'failed' : 'ended';
    if (reason === 'error' && !this.lastError) this.lastError = '未知错误';
    this.log?.info('通话结束', {
      reason,
      connected: wasConnected,
      sent: this.sentFrames,
      received: this.receivedFrames,
    });
    this.emit();
  }

  private stopTimers(): void {
    const pairs: Array<[unknown, 'clearInterval' | 'clearTimeout']> = [
      [this.heartbeatTimer, 'clearInterval'],
      [this.statusTimer, 'clearInterval'],
      [this.qfbTimer, 'clearInterval'],
      [this.relayTimer, 'clearInterval'],
      [this.audioTimer, 'clearTimeout'],
      [this.ringTimer, 'clearTimeout'],
      [this.connectTimer, 'clearTimeout'],
    ];
    for (const [handle, kind] of pairs) {
      if (handle !== null) this.timers[kind](handle);
    }
    this.heartbeatTimer = null;
    this.statusTimer = null;
    this.qfbTimer = null;
    this.relayTimer = null;
    this.audioTimer = null;
    this.ringTimer = null;
    this.connectTimer = null;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

// ─────────────────────────── 组装 ───────────────────────────

/** 用 `@weq/protocol` 的信令实现 + 已登记的 pid 造一个信令客户端。 */
export function protocolSignaling(
  nt: Parameters<typeof startC2CCall>[0],
  pid: number,
): CallSignaling {
  return {
    start: (params) => startC2CCall(nt, pid, params),
    end: (params) => endC2CCall(nt, pid, params),
  };
}

/** 只读的会话参数（给界面显示用）。 */
export interface CallTarget {
  uin: string;
  uid: string;
  displayName?: string;
  avatarUrl?: string;
}
