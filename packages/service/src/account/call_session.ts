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
  buildVideoControl,
  buildVideoKeepalive,
  buildVideoPackets,
  buildVideoSubHeader,
  extractHevc,
  parseAudioFrame,
  parseAudioHeader,
  parseCallEvent,
  parseFecContainer,
  parseGcsPacket,
  parseQfb,
  parseVideoPacket,
  rsEncode,
  splitHevcNals,
  VIDEO_CTRL_SUB_TYPE,
  VIDEO_KEEPALIVE_SUB_TYPE,
  VideoFrameAssembler,
  isVideoSubType,
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
  /** 本端摄像头是否开着（发视频中）。 */
  videoSending: boolean;
  /** 对端摄像头是否开着（收到对端视频流）。 */
  videoReceiving: boolean;
  /** 收到的视频帧数（含增强层）。 */
  receivedVideoFrames: number;
  /** 视频流的最近一次关键帧信息；没收到过为 null。 */
  videoInfo: VideoStreamInfo | null;
}

/** 从 SPS 里读出来的视频规格。 */
export interface VideoStreamInfo {
  width: number;
  height: number;
  /** HEVC profile（1 = Main）。 */
  profile: number;
  /** 编码格式，目前只认 hevc。 */
  codec: 'hevc';
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

/**
 * 视频编码能力（H.265）。由主进程注入，`CallSession` 只负责打包与发。
 *
 * 之所以做成回调而不是内置：H.265 编码要么用系统 `ffmpeg` / `x265`，要么走
 * 浏览器的 WebCodecs（在渲染进程里），两条路的生命周期管理完全不同。会话层
 * 只关心「给我一帧 Annex B」。
 */
export interface CallVideoEncoder {
  /** 取下一帧 Annex B 裸流；没有新画面时返回 null（不发包）。 */
  next(): Promise<Uint8Array | null>;
  /** 视频规格（写进 SPS，供对端初始化）。 */
  info(): VideoStreamInfo;
  close(): void;
}

/** 借凭据发信令的最小表面（`@weq/protocol` 的实现直接满足）。 */
export interface CallSignaling {
  start(params: {
    selfUid: string;
    peerUid: string;
    media?: 'audio' | 'video';
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
/**
 * 收到一帧对端视频（已组装成完整帧，裸流通过 `hevc` 给出）。
 *
 * `hevc` 是 Annex B 裸流（含起始码），可直接喂给解码器；为 null 表示这一帧的
 * 载荷不是可识别的 H.265（加密或损坏），调用方应当跳过。
 */
export type CallVideoListener = (frame: VideoFramePayload, at: number) => void;

export interface VideoFramePayload {
  gidx: number;
  fidx: number;
  /** 基础层才能独立解码。 */
  isBaseLayer: boolean;
  isKeyframe: boolean;
  /** 真实帧时间戳（毫秒）。 */
  timestamp: number;
  /** 视频规格（只在关键帧上更新）。 */
  info: VideoStreamInfo | null;
  /** Annex B 裸流；不可识别时为 null。 */
  hevc: Uint8Array | null;
}

export interface CallSessionOptions {
  selfUin: string;
  selfUid: string;
  peerUin: string;
  peerUid: string;
  /** 通话媒体类型。默认 audio。 */
  media?: 'audio' | 'video';
  signaling: CallSignaling;
  transport: UdpTransport;
  codec: CallAudioCodec;
  /** 视频编码器。不给则只做接收（看不到本端画面）。 */
  videoEncoder?: CallVideoEncoder;
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
/** 视频保活周期（实测 2 秒）。 */
const VIDEO_KEEPALIVE_MS = 2000;
/** 视频发送轮询间隔：比最慢的帧间隔（10 fps）小一个量级。 */
const VIDEO_PUMP_MS = 10;

// ─────────────────────────── 会话 ───────────────────────────

/**
 * 从一帧 Annex B 里读 HEVC 规格（分辨率 / profile）。
 *
 * 只在关键帧上调：IDR 前面带 VPS + SPS + PPS，SPS 里有分辨率。实测视频流
 * 640×360 Main。解析失败返回 null —— 规格只是给界面显示的，读不到不影响解码。
 *
 * SPS 的字段顺序（HEVC）：`profile_tier_level`(12B) 之后是
 * `sps_seq_parameter_set_id`、`chroma_format_idc`（==3 时多一个
 * `separate_colour_plane_flag`）、`pic_width_in_luma_samples`、
 * `pic_height_in_luma_samples`，都是 Exp-Golomb。
 */
function readHevcInfo(annexb: Uint8Array): VideoStreamInfo | null {
  for (const nal of splitHevcNals(annexb)) {
    // SPS = 33。NAL 头 2 字节，之后是 RBSP。
    if (nal.type !== 33 || nal.data.length < 15) continue;
    const profile = nal.data[1]!; // profile_idc 在 NAL 头的第二个字节
    const rbsp = nal.data.subarray(2 + 12);
    const bits = new BitReader(rbsp);
    try {
      bits.ue(); // sps_seq_parameter_set_id
      const chroma = bits.ue();
      if (chroma === 3) bits.u(1); // separate_colour_plane_flag
      const width = bits.ue();
      const height = bits.ue();
      if (width > 0 && height > 0 && width < 16384 && height < 16384) {
        return { width, height, profile, codec: 'hevc' };
      }
    } catch {
      // 位读越界：这帧的 SPS 不完整，交给下一个关键帧。
    }
  }
  return null;
}

/** 极简位读取器，只够解析 SPS 的前几个 Exp-Golomb 字段。 */
class BitReader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  /** 读 n 位。 */
  u(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3];
      if (byte === undefined) throw new Error('位读越界');
      value = (value << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return value;
  }

  /** 无符号 Exp-Golomb。 */
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros > 32) throw new Error('Exp-Golomb 过长');
    }
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.u(zeros);
  }
}

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

  // 视频
  private readonly videoAssembler = new VideoFrameAssembler();
  private videoSending = false;
  private videoReceiving = false;
  private receivedVideoFrames = 0;
  private videoInfo: VideoStreamInfo | null = null;
  /** 视频帧序号（写进 sub-header，每帧 +1）。 */
  private videoFrameIndex = 0;
  private videoSeq = 0;
  /** 视频保活定时器。 */
  private videoKeepaliveTimer: unknown = null;
  /** 视频发送循环定时器。 */
  private videoTimer: unknown = null;
  /** 本端视频编码器（由主进程注入；没有就只做接收）。 */
  private videoEncoder: CallVideoEncoder | null = null;

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
  private readonly videoListeners = new Set<CallVideoListener>();

  constructor(options: CallSessionOptions) {
    this.opts = options;
    this.timers = options.timers ?? realTimers;
    this.log = options.logger;
    this.videoEncoder = options.videoEncoder ?? null;
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
      videoSending: this.videoSending,
      videoReceiving: this.videoReceiving,
      receivedVideoFrames: this.receivedVideoFrames,
      videoInfo: this.videoInfo,
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

  /** 收到一帧对端视频（已组装、已剥掉 sub-header 的 H.265 裸流）。 */
  onVideo(listener: CallVideoListener): () => void {
    this.videoListeners.add(listener);
    return () => this.videoListeners.delete(listener);
  }

  /**
   * 开 / 关本端摄像头。
   *
   * 协议上**没有**「开」和「关」两种包：两者都是同一条空体 `subType=4`，
   * 连发两次防丢包。所以这里只做「发控制包 + 切换本端发送状态」。
   *
   * 打开后真正发画面要等 `videoEncoder` 吐帧（见 {@link pumpVideo}）；
   * 没有注入编码器时只发控制包，对端会显示「等待对方画面」。
   */
  setCamera(enabled: boolean): void {
    if (this.state !== 'connected') return;
    if (this.videoSending === enabled) return;
    this.videoSending = enabled;
    this.sendVideoControl();
    if (enabled) {
      this.videoFrameIndex = 0;
      this.startVideoLoop();
      this.startVideoKeepalive();
    } else {
      this.stopVideoLoop();
    }
    this.log?.info('摄像头状态', { enabled });
    this.emit();
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
        media: this.opts.media ?? 'audio',
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
      // 这里必须**等**收尾走完才返回：`teardown` 是异步的，而终点状态
      // （`failed`）在它末尾才落下。不 await 的话调用方拿到的快照还是
      // `idle`，看起来像「什么都没发生」。
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.log?.error('通话失败', { error: message });
      await this.teardown('error');
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
   * 服务端给两张表：type=1 是 GCS（控制面 + 音频），type=2 是中继。
   *
   * 两张表里是**同一批机器**，只是端口不同（GCS 8000/8001，中继 8800）。
   * 所以「选哪个」不是查表的事 —— 得挑一个真的能收发的。这里的策略：
   *
   *   1. 首次认证从 type=1 的第一台开始，失败（3 秒内没有认证回包）就换下一台；
   *   2. 全部失败再退到 type=2；
   *   3. 中继列表也去重，同一对 ip:port 只注册一次。
   *
   * 试错结果记在 {@link goodGcs}，同一进程内的后续通话直接复用 —— 服务端每次
   * 分配的机器会变，但可达性通常一致，能省掉一次 3 秒的空等。
   */
  private pickServers(servers: CallServer[]): void {
    const gcsCandidates = servers.filter((s) => s.type === 1);
    const relayCandidates = servers.filter((s) => s.type === 2);
    this.gcsCandidates = [...gcsCandidates, ...relayCandidates];
    this.gcs =
      this.gcsCandidates.find((s) => s.ip === CallSession.goodGcsIp) ??
      this.gcsCandidates[0] ??
      null;
    this.gcsIndex = Math.max(0, this.gcsCandidates.indexOf(this.gcs!));

    const seen = new Set<string>();
    this.relays = [];
    for (const server of [...relayCandidates, ...gcsCandidates]) {
      const key = `${server.ip}:${server.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.relays.push(server);
      if (this.relays.length >= 2) break;
    }
  }

  /** 候选 GCS 地址，按尝试顺序。 */
  private gcsCandidates: CallServer[] = [];
  /**
   * 进程内记住上次认证成功的 GCS **IP**（端口每次会变，不能整条复用）。
   *
   * 服务端每次分配的机器在一小撮里轮换，可达的那几台通常一直可达 —— 记住它
   * 能省掉首次的 3 秒探测。
   */
  private static goodGcsIp: string | null = null;
  /** 当前在第几台候选上。 */
  private gcsIndex = 0;
  /** 切换 GCS 的定时器。 */
  private gcsRetryTimer: unknown = null;
  /** 本轮是否已收到认证回包。 */
  private authAcked = false;

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
    if (!this.room || !this.gcs) return;
    const packet = buildGcsAuth({
      roomId: this.room.roomId,
      selfUin: Number(this.opts.selfUin),
      typeId: GCS_TYPE_ID_BASE,
      authKey: this.room.authKey,
      capabilities: DEFAULT_CAPABILITIES,
    });
    this.authAcked = false;
    // 真实客户端连发两次；服务端对重复认证是幂等的。
    this.send(packet);
    this.send(packet);
    this.armGcsProbe();
  }

  /**
   * 3 秒内没等到认证回包就换下一台 GCS。
   *
   * 服务端给的地址里总有一两台是当前网络到不了的（跨运营商 / IPv6-only 的
   * 备用地址）。真实客户端会并行试多个，我们串行试 —— 3 秒足够一次 RTT，
   * 又不会让用户等太久。
   */
  private armGcsProbe(): void {
    this.clearGcsRetry();
    this.gcsRetryTimer = this.timers.setTimeout(() => {
      this.gcsRetryTimer = null;
      if (this.authAcked) return;
      if (this.gcsIndex + 1 >= this.gcsCandidates.length) {
        // 全部试过还是不通：留着当前这台继续心跳，可能是回包慢。
        this.log?.warn('所有 GCS 候选都没有认证回包');
        return;
      }
      this.gcsIndex++;
      this.gcs = this.gcsCandidates[this.gcsIndex]!;
      this.log?.debug('切换 GCS', { ip: this.gcs.ip, port: this.gcs.port });
      this.sendAuth();
      this.sendRelayGetIn();
      this.sendCodecInit();
    }, 3000);
  }

  private clearGcsRetry(): void {
    if (this.gcsRetryTimer !== null) {
      this.timers.clearTimeout(this.gcsRetryTimer);
      this.gcsRetryTimer = null;
    }
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
    this.authAcked = true;
    this.clearGcsRetry();
    if (this.gcs) CallSession.goodGcsIp = this.gcs.ip;
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

  /**
   * `0x5b` 的分流。
   *
   * 音频、视频、质量反馈、控制包共用这一个首字节，靠 `[3]` 的 subType 区分：
   *
   *   0x01 音频 / 0x02 大画面 / 0x03 小画面 / 0x07 屏幕共享
   *   0x04 摄像头开关控制 / 0x05 视频保活 / 0x0e 质量反馈
   *
   * ⚠️ 早先这里对非音频一律 `return`，视频包会被**静默丢弃**——表现为「对方
   * 明明开了摄像头但什么都收不到」。
   */
  private handleAudio(data: Uint8Array): void {
    const header = parseAudioHeader(data);
    if (!header) return;
    this.lastPeerTick = header.tick;

    switch (header.subType) {
      case AudioSubType.qfb:
        this.handleQfb(data, header.tick);
        return;
      case VIDEO_CTRL_SUB_TYPE:
        this.handleVideoControl();
        return;
      case VIDEO_KEEPALIVE_SUB_TYPE:
        // 保活只说明「对端视频会话还在」，不改变状态。
        return;
      case AudioSubType.audio:
        this.handleAudioFrame(data);
        return;
      default:
        if (isVideoSubType(header.subType)) {
          this.handleVideoPacket(data);
          return;
        }
        return;
    }
  }

  private handleQfb(data: Uint8Array, tick: number): void {
    const qfb = parseQfb(data.subarray(17));
    if (qfb && qfb.type === 1) {
      this.send(
        buildQfbResponse({
          seq: this.qfbSeq,
          sessionTs: this.sessionTs,
          tick: this.tick(),
          qfbSeq: qfb.qfbSeq,
          echoTs: tick,
        }),
      );
    }
  }

  private handleAudioFrame(data: Uint8Array): void {
    const frame = parseAudioFrame(data);
    if (!frame?.isOpus || frame.payload.length === 0) return;

    // 组内前 3 帧带的是上一组的校验行，这里不做恢复（服务端已保证 Jitter
    // Buffer 足够长），只负责把 FEC 容器从载荷里切掉。
    if (frame.version === 0x50) {
      parseFecContainer(data.subarray(17));
    }

    this.receivedFrames++;
    void this.deliverAudio(frame);
  }

  private async deliverAudio(frame: AudioFrame): Promise<void> {
    try {
      const pcm = await this.opts.codec.decode(frame.payload);
      for (const listener of this.audioListeners) listener(pcm, this.timers.now());
    } catch (error) {
      this.log?.warn('解码一帧失败', { error });
    }
  }

  // ── 视频 ──

  /**
   * 收到对端的摄像头开关控制包（`subType=4`，空体）。
   *
   * 协议里**没有**开关位：收到一条就说明对端的摄像头状态**取反**。真正的画面
   * 会在随后几十毫秒内到（开）或停止（关）。
   *
   * 这里以「是否真的收到视频包」为准来维护 `videoReceiving`，控制包只用来
   * 记日志——对端可能因为采集失败（比如 Wayland 下的屏幕共享）发了控制包却
   * 出不来画面，那时不该显示「对方正在视频」。
   */
  private handleVideoControl(): void {
    this.log?.debug('对端摄像头开关控制包', { receiving: this.videoReceiving });
  }

  private handleVideoPacket(data: Uint8Array): void {
    const packet = parseVideoPacket(data);
    if (!packet) return;

    const frame = this.videoAssembler.push(packet, this.timers.now());
    if (!frame) return;

    if (!this.videoReceiving) {
      this.videoReceiving = true;
      this.log?.info('开始接收对端视频', { subType: packet.subType });
      this.emit();
    }
    this.receivedVideoFrames++;

    const hevc = extractHevc(frame);
    // 只在关键帧上读规格，避免每帧都解析 SPS。
    if (hevc && frame.isKeyframe) {
      const info = readHevcInfo(hevc);
      if (info && !this.videoInfo) {
        this.videoInfo = info;
        this.log?.info('对端视频规格', { ...info });
        this.emit();
      }
    }

    const payload: VideoFramePayload = {
      gidx: frame.gidx,
      fidx: frame.fidx,
      isBaseLayer: frame.isBaseLayer,
      isKeyframe: frame.isKeyframe,
      timestamp: frame.timestamp,
      info: this.videoInfo,
      hevc,
    };
    const at = this.timers.now();
    for (const listener of this.videoListeners) listener(payload, at);
  }

  /** 发摄像头开关控制包（连发两次防丢包，与真实客户端一致）。 */
  private sendVideoControl(): void {
    const packet = buildVideoControl({
      sessionTs: this.sessionTs,
      tick: this.tick(),
    });
    this.send(packet);
    this.send(packet);
  }

  /** 视频保活：每 2 秒一条，视频停了也继续发到挂断。 */
  private startVideoKeepalive(): void {
    if (this.videoKeepaliveTimer !== null) return;
    const beat = () => {
      this.send(
        buildVideoKeepalive({
          sessionTs: this.sessionTs,
          tick: this.tick(),
        }),
      );
    };
    beat();
    this.videoKeepaliveTimer = this.timers.setInterval(beat, VIDEO_KEEPALIVE_MS);
  }

  private stopVideoKeepalive(): void {
    if (this.videoKeepaliveTimer === null) return;
    this.timers.clearInterval(this.videoKeepaliveTimer);
    this.videoKeepaliveTimer = null;
  }

  /**
   * 视频发送循环。
   *
   * 与音频的固定 20 ms 节拍不同，视频帧率由编码器决定（实测 10 fps，且帧间隔
   * 抖动很大）——所以这里是「编码器有帧就发，没有就等下一拍」。用 10 ms 的
   * 轮询兜住：比最慢的帧间隔小一个量级，又不会把主进程拖满。
   */
  private startVideoLoop(): void {
    if (this.videoTimer !== null) return;
    const pump = () => {
      this.videoTimer = this.timers.setTimeout(() => {
        void this.pumpVideo();
      }, VIDEO_PUMP_MS);
    };
    pump();
  }

  private stopVideoLoop(): void {
    if (this.videoTimer === null) return;
    this.timers.clearTimeout(this.videoTimer);
    this.videoTimer = null;
  }

  private async pumpVideo(): Promise<void> {
    if (!this.videoSending || this.state !== 'connected') return;
    const encoder = this.videoEncoder;
    if (!encoder) {
      // 没有编码器：控制包已经发了，画面等前端接上再说。
      this.videoTimer = this.timers.setTimeout(() => {
        void this.pumpVideo();
      }, VIDEO_PUMP_MS);
      return;
    }

    try {
      const hevc = await encoder.next();
      if (hevc && hevc.length > 0) this.sendVideoFrame(hevc);
    } catch (error) {
      this.log?.warn('编码一帧视频失败', { error });
    }

    if (!this.videoSending) return;
    this.videoTimer = this.timers.setTimeout(() => {
      void this.pumpVideo();
    }, VIDEO_PUMP_MS);
  }

  /**
   * 把一帧 Annex B 裸流切包发出去。
   *
   * 20 字节 sub-header + 裸流按 `maxPayload` 切分，每片一个 `0x5b subType=2`
   * 包。实测单个 UDP 载荷约 1200 字节（IPv6 路径下更大，但 1200 是安全值）。
   */
  private sendVideoFrame(hevc: Uint8Array): void {
    const timestampMs = this.tick();
    const subHeader = buildVideoSubHeader({
      gidx: this.videoFrameIndex & 0xff,
      frameIndex: this.videoFrameIndex,
      timestampMs,
      variant: this.videoFrameIndex === 0 ? 1 : 0,
    });
    const frameData = new Uint8Array(subHeader.length + hevc.length);
    frameData.set(subHeader, 0);
    frameData.set(hevc, subHeader.length);

    const packets = buildVideoPackets({
      frameData,
      gidx: this.videoFrameIndex & 0xff,
      sessionTs: this.sessionTs,
      tick: this.tick(),
      seq: ++this.videoSeq,
    });
    for (const packet of packets) this.send(packet);
    this.videoFrameIndex++;
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

    // 只要房间建出来了就必须收尾 —— 包括**失败路径**：开房 + 邀请是两条独立的
    // 信令，后者成功时对端已经在振铃了。此时若因为后面某一步（编解码器、UDP
    // 绑定…）失败就直接返回，对端会一直响到服务端超时。失败时更该主动挂断。
    if (this.room) {
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

    // 先把状态落到终态，再释放资源。
    //
    // 顺序反过来过一次：`codec.close()` 卸载 native 模块时，Windows 上曾直接
    // fail-fast 掉整个主进程（AVSDKPlugin 的后台线程还在跑，模块一卸就踩空）。
    // 进程都没了，后面那行「通话结束」自然也没人写 —— 界面上就是点了挂断毫无
    // 反应。native 侧已经改成模块永不卸载，但这里同样要把**本模块能控制的部分**
    // 排在前面：终态与日志先落，清理即使出岔子也不会让 UI 卡在「正在挂断」。
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

    // 释放顺序：先关 UDP 再关编解码器 —— 反过来的话，还在收包路径上的
    // 回调会拿着已关闭的解码器去解一帧。
    try {
      this.opts.transport.close();
    } catch (error) {
      this.log?.warn('关闭 UDP 失败', { error });
    }
    try {
      this.opts.codec.close();
    } catch (error) {
      this.log?.warn('关闭编解码器失败', { error });
    }
    try {
      this.videoEncoder?.close();
    } catch (error) {
      this.log?.warn('关闭视频编码器失败', { error });
    }
    this.videoEncoder = null;
    this.videoAssembler.reset();
    this.videoSending = false;
    this.videoReceiving = false;
    this.sendQueue.length = 0;
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
      [this.gcsRetryTimer, 'clearTimeout'],
      [this.videoKeepaliveTimer, 'clearInterval'],
      [this.videoTimer, 'clearTimeout'],
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
    this.gcsRetryTimer = null;
    this.videoKeepaliveTimer = null;
    this.videoTimer = null;
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
