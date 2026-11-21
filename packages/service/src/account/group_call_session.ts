/**
 * 群通话会话：房间 + 成员集合的状态机。
 *
 * 与私聊 {@link CallSession} **并列**，不共用状态机 —— 群聊没有 P2P、媒体全走
 * `0x02`、成员是集合而不是单个对端，硬塞进 `CallSession` 只会让两边都难读。
 *
 * 一次群通话的腿：
 *
 *   1. **信令**（TCP / SSO）：开房 → UDP 入房并并行多端同步 → 邀请 → 查房。
 *   2. **控制面**（UDP → `0x28` GCS）：入房认证（带 k1）→ 收 k2 → 应答 → 保活。
 *   3. **媒体**（UDP → `0x02`）：认证 → 订阅成员流 → `0x17` 上行 / `0x18` 下行。
 *
 * 本模块**不碰 Electron、不碰 native**：UDP 用 {@link UdpTransport}，编解码用
 * {@link CallAudioCodec}，信令用 {@link GroupCallSignaling}，全部由主进程注入。
 * 这样状态机可以在单测里用假时钟和假 socket 跑完整个生命周期。
 *
 * ⚠️ 只做「自己建房间、自己邀请」。被动接听由 QQ 本体的 AVSDK 消费，我们借凭据
 * 发包，收不到那条推送，所以没有「被邀请加入」这条路径。
 */

import { groupCall, MSG_PUSH_CMD } from '@weqbot/protocol';
import type { Logger } from '../common/logger';

const {
  GROUP_MULTI_VIDEO_ACK,
  GROUP_MULTI_VIDEO_PUSH,
  GROUP_SESSION_KEY_LEN,
  GroupMemberEvent,
  GroupRelayCmd,
  GroupTrack,
  GroupVideoAssembler,
  buildGroupAck,
  buildGroupAuth,
  buildGroupGcsEntry,
  buildGroupGcsEntryProbe,
  buildGroupGcsStatusReport,
  buildGroupAudioFrame,
  buildGroupExit,
  buildGroupGcsAck,
  buildGroupKeepaliveAck,
  buildGroupMemberStateAck,
  buildGroupMicState,
  buildGroupMultiVideoAck,
  buildGroupStreamSubscribe,
  buildGroupVideoFragments,
  decodeGroupCallInviteUpdates,
  extractGroupSessionKey,
  parseGroupAudioFrame,
  parseGroupCameraState,
  parseGroupAuthRsp,
  parseGroupGcsPacket,
  parseGroupMediaHeader,
  parseGroupMemberState,
  parseGroupRelay,
  parseGroupVideoFragment,
  groupFields,
  hasIdrNal,
  isGroupGcsEntryResponse,
  streamFromGcsFields,
} = groupCall;
type GroupGcsHead = Parameters<typeof buildGroupGcsEntryProbe>[1];

// ─────────────────────────── 状态 ───────────────────────────

export type GroupCallState =
  /** 还没开始 / 已彻底结束。 */
  | 'idle'
  /** 开房 + 邀请已发出，等成员进房。 */
  | 'calling'
  /** 已入房并认证，正在订阅成员流。 */
  | 'connecting'
  /** 至少收到过一条媒体包。 */
  | 'connected'
  /** 正在退出。 */
  | 'ending'
  /** 已结束。 */
  | 'ended'
  /** 异常结束。 */
  | 'failed';

/** 结束原因。 */
export type GroupCallEndReason = 'hangup' | 'all_left' | 'timeout' | 'connect_fail' | 'error';

/** 单个成员。 */
export interface GroupCallMember {
  uin: number;
  /** `u` 开头的 uid；从 `SsoQueryRoom` 的映射表来，拿不到时为 null。 */
  uid: string | null;
  /** 是否有视频轨（`0x19` 的媒体位）。 */
  video: boolean;
  /** 是否被静音。 */
  muted: boolean;
  /** 是否是自己。 */
  self: boolean;
  /** 加入时间（`now()`）。 */
  joinedAt: number;
}

/** 会话快照，透给界面。 */
export interface GroupCallSnapshot {
  state: GroupCallState;
  /** 群号（`0x28` 的 `f13`）。 */
  groupId: number;
  /** 房间归属 uin（开房回包的 `f1.f2`）。 */
  ownerUin: number;
  /** 成员表（按 uin 升序）。 */
  members: GroupCallMember[];
  pendingInviteUids: string[];
  /** 自己的 uin。 */
  selfUin: number;
  /** 自己的麦克风是否静音。 */
  micMuted: boolean;
  /** 自己的摄像头是否开。 */
  cameraOn: boolean;
  /** 结束原因（`ended` / `failed` 时有值）。 */
  endReason: GroupCallEndReason | null;
}

// ─────────────────────────── 依赖注入 ───────────────────────────

/** 群通话信令适配；开房、同步、UDP 入房和邀请按抓包顺序分开调用。 */
export interface GroupCallSignaling {
  /** 只开房；邀请必须等 GCS 入房与 0x25 认证请求发出后再调。 */
  create(params: { selfUid: string; groupId: number; profile?: number; media?: 1 | 2 }): Promise<{
    room: { ownerUin: number; authKey: Uint8Array; servers: Array<{ ip: string; port: number }> };
  }>;
  invite(params: {
    targetUids: string[];
    authKey: Uint8Array;
    groupId: number;
    streamPrefix: number;
    profile?: number;
    media?: 1 | 2;
  }): Promise<string[] | undefined>;
  /** 让同账号的其它设备也响铃。 */
  multiTerminalSync(params: {
    authKey: Uint8Array;
    groupId: number;
    profile?: number;
  }): Promise<void>;
  /** 原始 SSO 推送通道用于应答主叫的 MultiVideo 通知。 */
  push?: {
    subscribe(command: string, listener: (body: Uint8Array) => void): () => void;
    send(command: string, body: Uint8Array): Promise<void>;
  };
  /** 查一次房间成员。 */
  query(params: { groupId: number; authKey: Uint8Array; streamPrefix: number }): Promise<{
    members: Array<{ uin: number; uid: string | null }>;
  }>;
  removeMember?(params: {
    uid: string;
    groupId: number;
    authKey: Uint8Array;
    streamPrefix: number;
  }): Promise<void>;
}

/** UDP 传输由调用方提供。 */
export interface GroupCallTransport {
  bind(): Promise<void>;
  send(data: Uint8Array, port: number, address: string): void;
  close(): void;
  onMessage(handler: (data: Uint8Array, from: { address: string; port: number }) => void): void;
  onError(handler: (error: Error) => void): void;
}

/** 群通话的逐帧 SILK 编解码。 */
export interface GroupCallCodec {
  /** 640 字节 PCM → 裸 SILK。 */
  encode(pcm: Uint8Array): Promise<Uint8Array>;
  /** 裸 SILK → 640 字节 PCM。按成员保留解码上下文。 */
  decode(silk: Uint8Array, uin: number): Promise<Uint8Array>;
  resetMember?(uin: number): void;
}

interface ReceivedAudioStream {
  id: string;
  sampleTs: number;
  queued: number;
  decoded: Promise<void>;
}

/** 定时器，单测里换成手动推进的实现。 */
export interface GroupCallTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realGroupTimers: GroupCallTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** 会话选项。 */
export interface GroupCallSessionOptions {
  selfUin: number;
  selfUid: string;
  /** 要邀请的 uid 列表（至少一个）。 */
  targetUids: string[];
  memberDirectory?: Array<{ uin: number; uid: string }>;
  /** 群号。信令层从开房回包拿不到时由调用方从上下文传。 */
  groupId: number;
  /**
   * 本端 7 字节流标识。
   *
   * **不是客户端生成的** —— 服务端在入房应答的 `f4`/`f5` 里分配，会话收到后
   * 用 {@link streamFromGcsFields} 还原（见 `onEntryResponse`）。
   * 2026-11-05 静态比对两通抓包确认：客户端入房包 `f4=f5=0`，
   * 服务端回 `0x185706aa`/`0x677e0001` → 流标识 `18 57 06 aa 67 7e 00`。
   *
   * 保留这个字段只为测试注入固定值；生产路径不传。
   */
  stream?: Uint8Array;
  /** 覆盖协议层默认能力档，用于兼容旧版信令。 */
  profile?: number;
  /** 开房与邀请的媒体字段。抓包中观测到 1 和 2。 */
  media?: 1 | 2;
  /** AVSDK 首次 `0x28` 入房请求里的能力 body；当前协议层将其作为 opaque bytes 传入。 */
  gcsEntryBody: Uint8Array;
  signaling: GroupCallSignaling;
  transport: GroupCallTransport;
  codec: GroupCallCodec;
  timers?: GroupCallTimers;
  logger?: Logger;
}

/**
 * 生成本端的 7 字节流标识。
 *
 * 结构（三份抓包比对）：`18 | <随机 1B> | 06 | aa | <随机 2B> | 00`。
 * 中间那两个字节抓包里两次分别是 `57` / `b6` 和 `67 7e` / `47 32`，看不出与
 * 会话或账号的关联，按随机处理。
 */
export function makeGroupStream(random: (n: number) => Uint8Array = defaultRandom): Uint8Array {
  const bytes = random(3);
  return Uint8Array.from([0x18, bytes[0]!, 0x06, 0xaa, bytes[1]!, bytes[2]!, 0x00]);
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** 监听器。 */
export type GroupCallListener = (snapshot: GroupCallSnapshot) => void;
/** 收到一帧成员音频（已解码成 PCM）。 */
export type GroupCallAudioListener = (pcm: Uint8Array, uin: number, at: number) => void;
/** 收到一帧成员视频（Annex B H.264）。 */
export type GroupCallVideoListener = (
  data: Uint8Array,
  info: { uin: number; keyframe: boolean },
  at: number,
) => void;

// ─────────────────────────── 常量 ───────────────────────────

/** 保活应答的检查周期。服务端 2 秒发一次 `0x2d`，缺两拍就拆房间。 */
const KEEPALIVE_WATCH_MS = 2000;
/** 多久没收到 `0x2d` 就判定断线。 */
const KEEPALIVE_TIMEOUT_MS = 6000;
const AUTH_RENEW_MS = 15_000;
const GCS_STATUS_INTERVAL_MS = 2000;
const FIRST_AUTH_RETRY_MS = 170;
const INVITE_DELAY_MS = 65;
const INITIAL_ROOM_QUERY_DELAY_MS = 300;
/** 等待中继完成认证的上限。 */
const RING_TIMEOUT_MS = 60_000;
const INVITE_TIMEOUT_MS = 64_000;
/** 退出包重发间隔与次数：② 抓包里连发 5 次直到收到 `0x12`。 */
const EXIT_RETRY_MS = 100;
const EXIT_RETRY_MAX = 5;
/** 音频一帧 20 ms。 */
const _FRAME_MS = 20;
/** 每帧 320 个采样（16 kHz × 20 ms）。 */
const FRAME_SAMPLES = 320;
const AUDIO_FRAME_MS = 20;
const MAX_AUDIO_DECODE_QUEUE = 5;

// ─────────────────────────── 会话 ───────────────────────────

export class GroupCallSession {
  private readonly opts: GroupCallSessionOptions;
  private readonly timers: GroupCallTimers;

  private state: GroupCallState = 'idle';
  private endReason: GroupCallEndReason | null = null;

  /** 开房回包的 authKey（k1）。 */
  private k1: Uint8Array | null = null;
  /** 服务端下发的会话密钥（k2）。收到前所有包用 k1。 */
  private k2: Uint8Array | null = null;
  private ownerUin = 0;
  private groupId: number;

  /** 本端 7 字节流标识；入房应答到达前为 null（由服务端分配）。 */
  private stream: Uint8Array | null;
  /** 本端 `0x02` 的 route 计数。 */
  private route = 0;
  private gcsSessionId = 0;
  private gcsNextSessionId = 0;
  private gcsReportedAt = 0;
  private gcsReportIndex = 0;
  private gcsRoundTripMs = 0;
  private reportAudioPackets = 0;
  private reportAudioBytes = 0;
  private reportVideoPackets = 0;
  private streamPrefix = 0;
  /** 音频帧号按 16 位编码，扩展头周期使用完整计数。 */
  private audioFrameIndex = 0;
  private audioCapturedAt: number | undefined;
  private videoPacketIndex = 0;
  private videoFrameIndex = 0;
  private videoGroupIndex = 0;
  private secondaryVideoFrameIndex = 0;

  /** 服务端中继地址。 */
  private server: { ip: string; port: number } | null = null;

  private readonly members = new Map<number, GroupCallMember>();
  private readonly receivedAudio = new Map<number, ReceivedAudioStream>();
  private readonly videoAssembler = new GroupVideoAssembler();

  private micMuted = false;
  private cameraOn = false;
  private lastKeepaliveAt = 0;
  private authMode: 1 | 3;
  private readonly pendingInvites = new Map<string, unknown>();
  private readonly finishedInvites = new Set<string>();
  private stopInvitePush: (() => void) | undefined;
  private firstAuthRetry: unknown;
  private authRenew: unknown;
  private videoSubscription: number[] = [];
  private readonly memberUids = new Map<number, string>();

  private readonly listeners = new Set<GroupCallListener>();
  private readonly audioListeners = new Set<GroupCallAudioListener>();
  private readonly videoListeners = new Set<GroupCallVideoListener>();

  private readonly handles: unknown[] = [];
  private exitRoute: number | undefined;
  private exitTimer: unknown;
  private hangingUp: Promise<void> | undefined;
  private stopSsoPush: (() => void) | undefined;
  /** 退出重发的完成回调；收到 `0x12` 时调用。 */
  private exitDone: (() => void) | null = null;

  constructor(options: GroupCallSessionOptions) {
    this.opts = options;
    this.timers = options.timers ?? realGroupTimers;
    this.groupId = options.groupId;
    this.stream = options.stream ?? null;
    this.authMode = options.media === 1 ? 1 : 3;
    this.cameraOn = options.media === 2;
    this.addMemberIdentities(options.memberDirectory ?? []);
  }

  // ─────────────────────────── 生命周期 ───────────────────────────

  /**
   * 开房后发 UDP 入房和多端同步。邀请等待首条中继认证请求发出。
   */
  async start(): Promise<GroupCallSnapshot> {
    if (this.state !== 'idle') throw new Error(`群通话已在 ${this.state} 状态`);
    if (this.opts.targetUids.length === 0) throw new Error('至少需要一个邀请目标');

    this.setState('calling');
    if (!this.isActive()) return this.snapshot();
    try {
      const { room } = await this.opts.signaling.create({
        selfUid: this.opts.selfUid,
        groupId: this.groupId,
        profile: this.opts.profile,
        media: this.opts.media,
      });
      this.k1 = room.authKey;
      this.ownerUin = room.ownerUin;
      this.server = pickServer(room.servers);

      if (!this.isActive()) return this.snapshot();

      if (!this.server) throw new Error('开房回包里没有可用的服务器地址');

      await this.opts.transport.bind();
      if (!this.isActive()) {
        this.opts.transport.close();
        return this.snapshot();
      }
      this.opts.transport.onMessage((data, from) => this.onPacket(data, from));
      this.opts.transport.onError((error) => {
        this.opts.logger?.warn?.('群通话 UDP 错误', { error: error.message });
      });

      this.subscribeToSsoPush();
      this.startTimers();
      this.sendEntry();
      void this.opts.signaling
        .multiTerminalSync({
          authKey: room.authKey,
          groupId: this.groupId,
          profile: this.opts.profile,
        })
        .catch((error: unknown) => {
          this.opts.logger?.warn?.('群通话多端同步失败', { error: String(error) });
        });
      return this.snapshot();
    } catch (error) {
      if (this.isActive()) this.fail('connect_fail');
      throw error;
    }
  }

  async hangup(): Promise<void> {
    if (this.hangingUp) return this.hangingUp;
    if (!this.isActive()) return;

    const key = this.currentKey();
    const stream = this.stream;
    let settle!: () => void;
    this.hangingUp = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.stopTimers();
    this.setState('ending');
    try {
      if (key && stream && this.server) await this.sendExitAndWait(key, stream);
    } finally {
      try {
        this.finish('hangup');
      } finally {
        settle();
      }
    }
  }

  /** 重传同一份退出包。带相同 route 的 0x12 可提前完成。 */
  private sendExitAndWait(key: Uint8Array, stream: Uint8Array): Promise<void> {
    const route = this.nextRoute();
    const packet = buildGroupExit({ route, ownerUin: this.opts.selfUin, stream, key });
    this.exitRoute = route;
    return new Promise((resolve) => {
      let sent = 0;
      this.exitDone = () => {
        if (this.exitTimer !== undefined) this.timers.clearTimeout(this.exitTimer);
        this.exitRoute = undefined;
        this.exitTimer = undefined;
        this.exitDone = null;
        resolve();
      };
      const tick = () => {
        if (sent === EXIT_RETRY_MAX) {
          this.exitDone?.();
          return;
        }
        sent += 1;
        this.sendRelay(packet);
        if (this.exitDone) this.exitTimer = this.timers.setTimeout(tick, EXIT_RETRY_MS);
      };
      tick();
    });
  }

  // ─────────────────────────── 麦克风 / 摄像头 ───────────────────────────

  /** 开关自己的麦克风（`0x73`，目标为空 = 操作自己）。 */
  setMic(muted: boolean): void {
    const key = this.currentKey();
    if (!key || !this.stream || !this.isActive()) return;
    this.micMuted = muted;
    this.sendRelay(
      buildGroupMicState({
        route: this.nextRoute(),
        ownerUin: this.opts.selfUin,
        stream: this.stream!,
        key,
        muted,
      }),
    );
    this.emit();
  }

  /** 静音别人（`0x73` 带目标 uin）。 */
  muteMember(uin: number): void {
    const key = this.currentKey();
    if (!key || !this.stream || !this.isActive()) return;
    this.sendRelay(
      buildGroupMicState({
        route: this.nextRoute(),
        ownerUin: this.opts.selfUin,
        stream: this.stream!,
        key,
        muted: true,
        targetUin: uin,
      }),
    );
  }

  /** 成员真正离开时由中继的成员状态更新快照。 */
  async removeMember(uin: number): Promise<void> {
    const member = this.members.get(uin);
    if (
      !this.isMediaActive() ||
      this.ownerUin !== this.opts.selfUin ||
      member?.self ||
      !member?.uid
    ) {
      throw new Error('只有发起人可以移出房间内的其他成员');
    }
    if (!this.k1 || !this.streamPrefix || !this.opts.signaling.removeMember) {
      throw new Error('当前房间无法移出成员');
    }
    await this.opts.signaling.removeMember({
      uid: member.uid,
      groupId: this.groupId,
      authKey: this.k1,
      streamPrefix: this.streamPrefix,
    });
  }

  setCamera(on: boolean): void {
    if (!this.isActive() || this.cameraOn === on) return;
    this.cameraOn = on;
    const mode = on ? 3 : 1;
    this.authMode = mode;
    if (this.streamPrefix !== 0) {
      this.authenticate();
      this.scheduleAuthRenewal();
      this.subscribeStreams();
    }
    this.emit();
  }

  // ─────────────────────────── 媒体 ───────────────────────────

  /**
   * 推一帧 PCM（640 字节，16 kHz 单声道）。
   *
   * 编码后包成 `0x17` 发出。静音时直接丢弃 —— 服务端不替我们做静音。
   */
  async pushAudio(pcm: Uint8Array): Promise<void> {
    if (!this.isMediaActive()) return;
    if (this.micMuted || !this.stream) return;
    if (pcm.length !== FRAME_SAMPLES * 2) {
      throw new RangeError(`一帧必须是 ${FRAME_SAMPLES * 2} 字节 PCM，收到 ${pcm.length}`);
    }

    const now = this.timers.now();
    const silk = await this.opts.codec.encode(pcm);
    if (!this.isMediaActive() || this.micMuted || !this.stream) return;
    // 正常维持 20 ms 的采样步长。暂停采集或静音后按新的采集时刻继续。
    const nextCapture = (this.audioCapturedAt ?? now - AUDIO_FRAME_MS) + AUDIO_FRAME_MS;
    const capturedAt = now - nextCapture > AUDIO_FRAME_MS * 2 ? now : nextCapture;
    this.audioCapturedAt = capturedAt;
    this.sendRelay(
      buildGroupAudioFrame({
        route: this.nextRoute(),
        ownerUin: this.opts.selfUin,
        stream: this.stream!,
        sentAt: this.timers.now(),
        capturedAt,
        frameIndex: ++this.audioFrameIndex,
        sampleTs: (capturedAt * 16) >>> 0,
        silk,
        profile: this.opts.profile,
      }),
    );
  }

  /** 推一帧 H.264 Annex B。可同时发送由调用方独立编码的低分辨率轨。 */
  pushVideoFrame(data: Uint8Array, keyframe = hasIdrNal(data), secondary?: Uint8Array): void {
    if (!this.cameraOn || !this.stream || !this.isMediaActive() || data.length === 0) return;
    const capturedAt = this.timers.now();
    if (keyframe) this.videoGroupIndex = (this.videoGroupIndex + 1) & 0xff;
    this.sendVideoTrack(data, keyframe, capturedAt, false);
    if (secondary?.length) this.sendVideoTrack(secondary, hasIdrNal(secondary), capturedAt, true);
  }

  private sendVideoTrack(
    data: Uint8Array,
    keyframe: boolean,
    capturedAt: number,
    secondary: boolean,
  ): void {
    const packets = buildGroupVideoFragments({
      route: this.nextRoute(),
      ownerUin: this.opts.selfUin,
      stream: this.stream!,
      seq: this.videoPacketIndex,
      sentAt: this.timers.now(),
      capturedAt,
      profile: this.opts.profile,
      groupIndex: this.videoGroupIndex,
      frameIndex: secondary ? this.secondaryVideoFrameIndex : this.videoFrameIndex,
      packetIndex: this.videoPacketIndex,
      data,
      keyframe,
      secondary,
    });
    this.route = (this.route + packets.length - 1) & 0xffffff;
    if (secondary) {
      this.secondaryVideoFrameIndex = (this.secondaryVideoFrameIndex + 1) & 0xff;
    } else {
      this.videoPacketIndex = (this.videoPacketIndex + packets.length) & 0xffff;
      this.videoFrameIndex = (this.videoFrameIndex + 1) & 0xff;
    }
    for (const packet of packets) this.sendRelay(packet);
  }

  /**
   * 入房认证（`0x02 cmd=0x25`）。
   *
   * 认证包里的流标识就是本端后续所有包的流标识（抓包里 `18 57 06 aa 67 7e 00`
   * 从第一次认证一直用到退出）。所以这一步既完成认证，也确定 `this.stream`。
   * 第一次用 k1，k2 下发后如果重认证要换成 k2。
   */
  private authenticate(key = this.currentKey()): void {
    if (!key || !this.stream) return;
    this.sendRelay(
      buildGroupAuth({
        route: this.nextRoute(),
        ownerUin: this.opts.selfUin,
        stream: this.stream,
        key,
        mode: this.authMode,
      }),
    );
  }

  // ─────────────────────────── 订阅 ───────────────────────────

  /** 状态快照。 */
  snapshot(): GroupCallSnapshot {
    return {
      state: this.state,
      groupId: this.groupId,
      ownerUin: this.ownerUin,
      members: [...this.members.values()]
        .sort((a, b) => a.uin - b.uin)
        .map((member) =>
          member.self ? { ...member, video: this.cameraOn, muted: this.micMuted } : { ...member },
        ),
      pendingInviteUids: [...this.pendingInvites.keys()],
      selfUin: this.opts.selfUin,
      micMuted: this.micMuted,
      cameraOn: this.cameraOn,
      endReason: this.endReason,
    };
  }

  onUpdate(listener: GroupCallListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAudio(listener: GroupCallAudioListener): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  onVideo(listener: GroupCallVideoListener): () => void {
    this.videoListeners.add(listener);
    return () => this.videoListeners.delete(listener);
  }

  // ─────────────────────────── 收包 ───────────────────────────

  private onPacket(data: Uint8Array, _from: { address: string; port: number }): void {
    if (data.length < 9 || (!this.isActive() && this.state !== 'ending')) return;
    if (data[0] === 0x28) this.onGcsPacket(data);
    else if (data[0] === 0x02) this.onRelayPacket(data);
  }

  private onGcsPacket(data: Uint8Array): void {
    const packet = parseGroupGcsPacket(data);
    if (!packet) return;

    this.lastKeepaliveAt = this.timers.now();
    if (
      packet.head.seq === 278 &&
      packet.head.sessionId === this.gcsNextSessionId - 1 &&
      this.gcsReportIndex > 0 &&
      groupFields(packet.body).has(3)
    ) {
      this.gcsRoundTripMs = Math.max(0, this.timers.now() - this.gcsReportedAt);
    }

    const key = extractGroupSessionKey(packet.body);
    if (key && !this.k2) {
      this.k2 = key;
      if (this.videoSubscription.length && this.isActive()) this.subscribeStreams(true);
    }

    if (this.streamPrefix === 0 && isGroupGcsEntryResponse(packet, this.gcsSessionId)) {
      if (this.isActive()) this.onEntryResponse(packet.head);
      return;
    }

    const currentKey = this.currentKey();
    if (!this.stream || !currentKey) return;
    const ack = buildGroupGcsAck({ key: currentKey, stream: this.stream }, packet);
    if (ack) this.sendRaw(ack);
  }

  private onRelayPacket(data: Uint8Array): void {
    const packet = parseGroupRelay(data);
    if (!packet || !this.stream) return;
    if (
      this.state === 'ending' &&
      packet.cmd !== GroupRelayCmd.exitAck &&
      packet.cmd !== GroupRelayCmd.memberState &&
      packet.cmd !== GroupRelayCmd.keepalive
    )
      return;

    switch (packet.cmd) {
      case GroupRelayCmd.keepalive:
        this.onKeepalive(packet);
        break;
      case GroupRelayCmd.memberState:
        this.onMemberState(packet);
        break;
      case GroupRelayCmd.cameraState:
        this.onCameraState(packet);
        break;
      case GroupRelayCmd.authRsp:
        this.onAuthRsp(packet);
        break;
      case GroupRelayCmd.exitAck:
        if (packet.route === this.exitRoute) this.exitDone?.();
        break;
      case GroupRelayCmd.mediaDown:
        this.onMedia(packet);
        break;
      case GroupRelayCmd.streamSubscribeAck:
      case GroupRelayCmd.memberStateAck:
      case GroupRelayCmd.cameraStateAck:
      case GroupRelayCmd.micStateAck:
        // 都是 16 字节的空应答，无需处理。
        break;
      default:
        break;
    }
  }

  private onKeepalive(packet: { route: number; body: Uint8Array }): void {
    this.lastKeepaliveAt = this.timers.now();
    this.sendRelay(
      buildGroupKeepaliveAck({
        route: packet.route,
        ownerUin: this.opts.selfUin,
        stream: this.stream!,
      }),
    );
  }

  private onMemberState(packet: { route: number; body: Uint8Array }): void {
    const stream = this.stream;
    const state = parseGroupMemberState(packet.body);
    if (!state || !stream) return;
    this.sendRelay(
      buildGroupMemberStateAck({
        route: packet.route,
        ownerUin: this.opts.selfUin,
        stream,
      }),
    );

    const self = state.uin === this.opts.selfUin;
    const previous = this.members.get(state.uin);
    if (state.event === GroupMemberEvent.leave) {
      this.members.delete(state.uin);
      this.receivedAudio.delete(state.uin);
      this.opts.codec.resetMember?.(state.uin);
      this.videoAssembler.reset(state.uin);
      if (self && this.isActive()) {
        this.finish('all_left');
        return;
      }
    } else {
      this.members.set(state.uin, {
        uin: state.uin,
        uid: this.memberUids.get(state.uin) ?? null,
        video: state.video,
        muted: state.muted,
        self,
        joinedAt: previous?.joinedAt ?? this.timers.now(),
      });
      const uid = this.memberUids.get(state.uin);
      if (uid) this.removePendingInvite(uid);
      if (previous?.video && !state.video) this.videoAssembler.reset(state.uin);
    }

    // 订阅表随远端视频变化。
    if (!self && this.isActive()) this.subscribeStreams();
    if (!self && state.event !== GroupMemberEvent.leave && this.state === 'connecting') {
      this.state = 'connected';
    }
    this.emit();
  }

  private onCameraState(packet: { route: number; body: Uint8Array }): void {
    const state = parseGroupCameraState(packet.body);
    if (state) {
      const member = this.members.get(state.uin);
      if (member && !member.self && member.video !== state.on) {
        member.video = state.on;
        if (!state.on) this.videoAssembler.reset(state.uin);
        if (this.isActive()) this.subscribeStreams();
        this.emit();
      }
    }
    this.sendRelay(
      buildGroupAck({
        route: packet.route,
        ownerUin: this.opts.selfUin,
        stream: this.stream!,
        cmd: GroupRelayCmd.cameraStateAck,
      }),
    );
  }

  private onAuthRsp(packet: { body: Uint8Array }): void {
    if (!parseGroupAuthRsp(packet.body).ok || this.streamPrefix === 0) return;
    if (this.state === 'calling') this.setState('connecting');
  }

  private onMedia(packet: { ownerUin: number; body: Uint8Array }): void {
    if (!this.isMediaActive()) return;
    const header = parseGroupMediaHeader(packet.body);
    if (!header || packet.ownerUin === this.opts.selfUin) return;

    if (header.track === GroupTrack.audio) {
      const frame = parseGroupAudioFrame(packet.body);
      if (!frame) return;
      this.reportAudioPackets += 1;
      this.reportAudioBytes += frame.payload.length;
      this.setState('connected');
      this.queueAudio(packet.ownerUin, header.stream.join(','), frame);
      return;
    }

    const fragment = parseGroupVideoFragment(packet.body);
    if (!fragment) return;
    this.reportVideoPackets += 1;
    const frame = this.videoAssembler.push(packet.ownerUin, fragment);
    if (!frame) return;
    this.setState('connected');
    const at = this.timers.now();
    for (const listener of this.videoListeners) {
      listener(frame.data, { uin: frame.ownerUin, keyframe: frame.keyframe }, at);
    }
  }

  private queueAudio(
    uin: number,
    streamId: string,
    frame: { payload: Uint8Array; sampleTs: number },
  ): void {
    let stream = this.receivedAudio.get(uin);
    // 有符号差值可跨 32 位采样时钟回绕比较。
    const delta = stream?.id === streamId ? (frame.sampleTs - stream.sampleTs) | 0 : undefined;
    if (delta !== undefined && delta <= 0) return;
    if (!stream || delta === undefined || delta > FRAME_SAMPLES * 3) {
      if (stream) this.opts.codec.resetMember?.(uin);
      stream = { id: streamId, sampleTs: frame.sampleTs, queued: 0, decoded: Promise.resolve() };
      this.receivedAudio.set(uin, stream);
    }
    if (stream.queued >= MAX_AUDIO_DECODE_QUEUE) return;
    stream.sampleTs = frame.sampleTs;
    stream.queued += 1;
    const current = stream;
    current.decoded = current.decoded.then(async () => {
      current.queued -= 1;
      if (this.receivedAudio.get(uin) !== current || !this.isMediaActive()) return;
      await this.emitAudio(frame.payload, uin, current);
    });
  }

  private async emitAudio(
    silk: Uint8Array,
    uin: number,
    stream: ReceivedAudioStream,
  ): Promise<void> {
    try {
      const pcm = await this.opts.codec.decode(silk, uin);
      if (!this.isMediaActive() || this.receivedAudio.get(uin) !== stream) return;
      const at = this.timers.now();
      for (const listener of this.audioListeners) listener(pcm, uin, at);
    } catch (error) {
      this.opts.logger?.warn?.('群通话音频解码失败', { error: String(error) });
    }
  }

  // ─────────────────────────── 发送 ───────────────────────────

  /** 首次远端视频出现后发送订阅表。保留本端或清空取决于当时的媒体状态。 */
  private subscribeStreams(keyChanged = false): void {
    const stream = this.stream;
    const key = this.currentKey();
    if (!stream || !key) return;
    const members = [...this.members.values()].filter((member) =>
      member.self ? this.cameraOn || (this.opts.media === undefined && member.video) : member.video,
    );
    const list = members
      .sort((a, b) => Number(b.self) - Number(a.self) || a.uin - b.uin)
      .map((member) => member.uin);
    const unchanged =
      this.videoSubscription.length === list.length &&
      this.videoSubscription.every((uin, index) => uin === list[index]);
    if (unchanged && !keyChanged) return;
    if (!this.videoSubscription.length && !members.some((member) => !member.self)) return;
    this.videoSubscription = list;
    this.sendRelay(
      buildGroupStreamSubscribe({
        route: this.nextRoute(),
        ownerUin: this.opts.selfUin,
        stream,
        key,
        memberUins: list,
      }),
    );
  }

  private sendRelay(packet: Uint8Array): void {
    if (!this.server) return;
    this.opts.transport.send(packet, this.server.port, this.server.ip);
  }

  private sendRaw(packet: Uint8Array): void {
    if (!this.server) return;
    this.opts.transport.send(packet, this.server.port, this.server.ip);
  }

  private currentKey(): Uint8Array | null {
    return this.k2 ?? this.k1;
  }

  private nextRoute(): number {
    this.route = (this.route + 1) & 0xffffff;
    return this.route;
  }

  /** 首包使用未认证 head（f4/f5=0），等服务端回 GCS 包后再做 0x25 认证。 */
  private sendEntry(): void {
    if (!this.k1 || !this.server) throw new Error('开房信息未就绪，无法发送 GCS 入房包');
    if (this.opts.gcsEntryBody.length === 0) throw new Error('缺少 GCS 入房能力 body');
    this.gcsSessionId = 20_000 + Math.floor(Math.random() * 10_000);
    this.sendRaw(
      buildGroupGcsEntry({
        sessionId: this.gcsSessionId,
        selfUin: this.opts.selfUin,
        key: this.k1,
        body: this.opts.gcsEntryBody,
      }),
    );
  }

  private subscribeToSsoPush(): void {
    const push = this.opts.signaling.push;
    if (!push) return;
    this.stopInvitePush = push.subscribe(MSG_PUSH_CMD, (body) => {
      if (!this.isActive()) return;
      let changed = false;
      for (const update of decodeGroupCallInviteUpdates(body)) {
        if (update.groupId !== this.groupId || update.room !== this.streamPrefix) continue;
        for (const uid of update.uids) {
          if (update.started) {
            this.finishedInvites.delete(uid);
          } else if (!this.finishedInvites.has(uid) && this.removePendingInvite(uid)) {
            this.finishedInvites.add(uid);
            changed = true;
          }
        }
      }
      if (changed) this.emit();
    });
    this.stopSsoPush = push.subscribe(GROUP_MULTI_VIDEO_PUSH, (body) => {
      if (!this.isActive()) return;
      const ack = buildGroupMultiVideoAck(body);
      if (ack) {
        void push.send(GROUP_MULTI_VIDEO_ACK, ack).catch((error: unknown) => {
          this.opts.logger?.warn?.('群通话通知应答失败', { error: String(error) });
        });
      }
    });
  }

  /** 从入房应答还原流标识，续探后发首个 0x25。 */
  private onEntryResponse(received: GroupGcsHead): void {
    const authKey = this.k1;
    if (!authKey) return;
    this.streamPrefix = received.f4;
    this.stream ??= streamFromGcsFields(received.f4, received.f5);
    this.sendRaw(buildGroupGcsEntryProbe({ key: authKey }, received));
    this.gcsNextSessionId = received.sessionId + (this.opts.media === 1 ? 3 : 4);
    this.gcsReportedAt = this.timers.now();
    this.handles.push(this.timers.setInterval(() => this.sendGcsStatus(), GCS_STATUS_INTERVAL_MS));
    this.authenticate(authKey);
    this.firstAuthRetry = this.timers.setTimeout(() => {
      this.firstAuthRetry = undefined;
      if (this.isActive()) this.authenticate();
    }, FIRST_AUTH_RETRY_MS);
    this.scheduleAuthRenewal();
    this.handles.push(
      this.timers.setTimeout(() => {
        if (this.isActive()) {
          void this.inviteMembers(this.opts.targetUids).catch((error: unknown) => {
            if (!this.isActive()) return;
            this.opts.logger?.warn?.('群通话邀请失败', { error: String(error) });
            this.fail('error');
          });
        }
      }, INVITE_DELAY_MS),
    );
  }

  addMemberIdentities(members: Array<{ uin: number; uid: string }>): void {
    let changed = false;
    for (const { uin, uid } of members) {
      this.memberUids.set(uin, uid);
      const member = this.members.get(uin);
      if (member && member.uid !== uid) {
        member.uid = uid;
        this.removePendingInvite(uid);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  async inviteMembers(uids: string[]): Promise<void> {
    const authKey = this.k1;
    const streamPrefix = this.streamPrefix;
    if (!authKey || !streamPrefix || !this.isActive()) throw new Error('通话尚未入房');
    const joined = new Set([...this.members.keys()].map((uin) => this.memberUids.get(uin)));
    const targetUids = [...new Set(uids)].filter(
      (uid) => uid !== this.opts.selfUid && !joined.has(uid) && !this.pendingInvites.has(uid),
    );
    if (!targetUids.length) return;
    const invites = targetUids.map((uid) => {
      const timer = this.timers.setTimeout(() => {
        if (this.removePendingInvite(uid)) this.emit();
      }, INVITE_TIMEOUT_MS);
      this.pendingInvites.set(uid, timer);
      return { uid, timer };
    });
    this.emit();
    try {
      const acknowledged = await this.opts.signaling.invite({
        targetUids,
        authKey,
        groupId: this.groupId,
        streamPrefix,
        profile: this.opts.profile,
        media: this.cameraOn ? 2 : 1,
      });
      this.removeUnacknowledgedInvites(invites, acknowledged);
    } catch (error) {
      this.removeUnacknowledgedInvites(invites, []);
      throw error;
    }
    if (this.isActive()) {
      this.handles.push(
        this.timers.setTimeout(() => void this.refreshMembers(), INITIAL_ROOM_QUERY_DELAY_MS),
      );
    }
  }

  private removeUnacknowledgedInvites(
    invites: Array<{ uid: string; timer: unknown }>,
    acknowledged: string[] | undefined,
  ): void {
    if (!acknowledged) return;
    let changed = false;
    for (const { uid, timer } of invites) {
      if (!acknowledged.includes(uid) && this.pendingInvites.get(uid) === timer) {
        changed = this.removePendingInvite(uid) || changed;
      }
    }
    if (changed) this.emit();
  }

  private removePendingInvite(uid: string): boolean {
    if (!this.pendingInvites.has(uid)) return false;
    this.timers.clearTimeout(this.pendingInvites.get(uid));
    return this.pendingInvites.delete(uid);
  }

  private sendGcsStatus(): void {
    const key = this.currentKey();
    const stream = this.stream;
    if (!key || !stream || !this.isActive()) return;
    const now = this.timers.now();
    const previousAt = this.gcsReportedAt;
    const packet = buildGroupGcsStatusReport({
      sessionId: this.gcsNextSessionId++,
      selfUin: this.opts.selfUin,
      stream,
      key,
      previousAt,
      now,
      reportIndex: this.gcsReportIndex++,
      video: this.cameraOn || (this.authMode === 3 && this.opts.media !== 1),
      receivedAudioPackets: this.reportAudioPackets,
      receivedAudioBytes: this.reportAudioBytes,
      receivedVideoPackets: this.reportVideoPackets,
      roundTripMs: this.gcsRoundTripMs,
    });
    this.gcsReportedAt = now;
    this.reportAudioPackets = this.reportAudioBytes = this.reportVideoPackets = 0;
    this.sendRaw(packet);
  }

  private scheduleAuthRenewal(): void {
    if (this.authRenew !== undefined) this.timers.clearTimeout(this.authRenew);
    this.authRenew = this.timers.setTimeout(() => {
      if (!this.isActive()) return;
      this.authenticate();
      this.scheduleAuthRenewal();
    }, AUTH_RENEW_MS);
  }

  private startTimers(): void {
    this.lastKeepaliveAt = this.timers.now();
    this.handles.push(
      this.timers.setInterval(() => this.checkKeepalive(), KEEPALIVE_WATCH_MS),
      this.timers.setTimeout(() => {
        if (this.state === 'calling') this.fail('timeout');
      }, RING_TIMEOUT_MS),
    );
  }

  private stopTimers(): void {
    if (this.firstAuthRetry !== undefined) this.timers.clearTimeout(this.firstAuthRetry);
    if (this.authRenew !== undefined) this.timers.clearTimeout(this.authRenew);
    this.firstAuthRetry = this.authRenew = undefined;
    for (const handle of this.handles) {
      this.timers.clearInterval(handle);
      this.timers.clearTimeout(handle);
    }
    this.handles.length = 0;
  }

  private checkKeepalive(): void {
    if (!this.isMediaActive()) return;
    if (this.timers.now() - this.lastKeepaliveAt > KEEPALIVE_TIMEOUT_MS) this.fail('connect_fail');
  }

  /** SSO 查房只补 UID。入房和退出由 UDP 通知驱动。 */
  private async refreshMembers(): Promise<void> {
    if (!this.isActive() || !this.k1 || !this.stream) return;
    try {
      const room = await this.opts.signaling.query({
        groupId: this.groupId,
        authKey: this.k1,
        streamPrefix: this.streamPrefix,
      });
      if (!this.isActive()) return;
      this.addMemberIdentities(room.members.flatMap(({ uin, uid }) => (uid ? [{ uin, uid }] : [])));
    } catch (error) {
      this.opts.logger?.warn?.('群通话成员查询失败', { error: String(error) });
    }
  }

  // ─────────────────────────── 状态 ───────────────────────────

  private isActive(): boolean {
    return this.state === 'calling' || this.isMediaActive();
  }

  private isMediaActive(): boolean {
    return this.state === 'connecting' || this.state === 'connected';
  }

  private setState(state: GroupCallState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit();
  }

  private fail(reason: GroupCallEndReason): void {
    this.finish(reason, 'failed');
  }

  private finish(reason: GroupCallEndReason, state: GroupCallState = 'ended'): void {
    this.stopTimers();
    this.exitDone?.();
    this.stopSsoPush?.();
    this.stopSsoPush = undefined;
    this.stopInvitePush?.();
    this.stopInvitePush = undefined;
    for (const timer of this.pendingInvites.values()) this.timers.clearTimeout(timer);
    this.pendingInvites.clear();
    this.finishedInvites.clear();
    this.receivedAudio.clear();
    this.videoAssembler.reset();
    this.endReason = reason;
    this.state = state;
    this.opts.transport.close();
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

// ─────────────────────────── 小工具 ───────────────────────────

/** 从服务器表里挑第一个可用地址（端口会变，必须用回包里读到的）。 */
function pickServer(
  servers: Array<{ ip: string; port: number }>,
): { ip: string; port: number } | null {
  return servers.find((server) => server.ip && server.port > 0) ?? null;
}

// 供调用方构造流标识时用的长度（7 字节）。
export const GROUP_STREAM_LEN = 7;
// 让类型检查器知道这个常量被引用了（会话密钥长度由协议层统一定义）。
export const SESSION_KEY_LEN = GROUP_SESSION_KEY_LEN;
