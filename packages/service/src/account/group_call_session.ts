/**
 * 群通话会话：房间 + 成员集合的状态机。
 *
 * 与私聊 {@link CallSession} **并列**，不共用状态机 —— 群聊没有 P2P、媒体全走
 * `0x02`、成员是集合而不是单个对端，硬塞进 `CallSession` 只会让两边都难读。
 *
 * 一次群通话的腿：
 *
 *   1. **信令**（TCP / SSO）：开房 → 多端同步 → 邀请 → 周期查询成员。
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

import { groupCall } from '@weq/protocol';
import type { Logger } from '../common/logger';

const {
  GROUP_SESSION_KEY_LEN,
  GroupAudioFragmentFlag,
  GroupMemberEvent,
  GroupRelayCmd,
  GroupTrack,
  GroupVideoAssembler,
  buildGroupAuth,
  buildGroupGcsEntry,
  buildGroupAudioFrame,
  buildGroupExit,
  buildGroupGcsAck,
  buildGroupKeepaliveAck,
  buildGroupMemberStateAck,
  buildGroupMicState,
  buildGroupRelay,
  buildGroupStreamSubscribe,
  buildGroupVideoFragments,
  extractGroupSessionKey,
  parseGroupAudioFrame,
  parseGroupCameraState,
  parseGroupAuthRsp,
  parseGroupGcsPacket,
  parseGroupMediaHeader,
  parseGroupMemberState,
  parseGroupRelay,
  parseGroupVideoFragment,
  hasIdrNal,
  streamFromGcsFields,
} = groupCall;
type GroupGcsHead = Parameters<typeof buildGroupGcsAck>[1];

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
  create(params: { selfUid: string; groupId: number }): Promise<{
    room: { ownerUin: number; authKey: Uint8Array; servers: Array<{ ip: string; port: number }> };
  }>;
  invite(params: { targetUids: string[]; authKey: Uint8Array; groupId: number }): Promise<void>;
  /** 让同账号的其它设备也响铃。 */
  multiTerminalSync(params: { authKey: Uint8Array; groupId: number }): Promise<void>;
  /** 查一次房间成员。 */
  query(params: { groupId: number; authKey: Uint8Array }): Promise<{
    members: Array<{ uin: number; uid: string | null }>;
  }>;
}

/** UDP 传输（复用私聊的 `NodeUdpTransport` 实现）。 */
export interface GroupCallTransport {
  bind(): Promise<void>;
  send(data: Uint8Array, port: number, address: string): void;
  close(): void;
  onMessage(handler: (data: Uint8Array, from: { address: string; port: number }) => void): void;
  onError(handler: (error: Error) => void): void;
}

/** 音频编解码（native 侧实现，测试里可以换成恒等变换）。 */
export interface GroupCallCodec {
  /** 640 字节 PCM → Opus。 */
  encode(pcm: Uint8Array): Promise<Uint8Array>;
  /** Opus → 640 字节 PCM。 */
  decode(opus: Uint8Array): Promise<Uint8Array>;
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
/** 成员查询周期（`SsoQueryRoom`）。 */
const QUERY_MEMBERS_MS = 5000;
/** 从发起到有人进房的上限。 */
const RING_TIMEOUT_MS = 60_000;
/** 退出包重发间隔与次数：② 抓包里连发 5 次直到收到 `0x12`。 */
const EXIT_RETRY_MS = 100;
const EXIT_RETRY_MAX = 10;
/** 音频一帧 20 ms。 */
const _FRAME_MS = 20;
/** 每帧 320 个采样（16 kHz × 20 ms）。 */
const FRAME_SAMPLES = 320;

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
  /** 本端 GCS 会话 ID 与序号（与收到的 s2c 流是两条独立序列）。 */
  private gcsSessionId = 0;
  private gcsSeq = 0;
  private gcsAckStarted = false;
  private entryResponseReceived = false;
  private inviteStarted = false;
  /** 本端 `0x17` 的包序号与采样时间戳。 */
  private mediaSeq = 0;
  private sampleTs = 0;
  private frameIndex = 0;

  /** 服务端中继地址。 */
  private server: { ip: string; port: number } | null = null;

  private readonly members = new Map<number, GroupCallMember>();
  private readonly videoAssembler = new GroupVideoAssembler();

  private micMuted = false;
  private cameraOn = false;
  private lastKeepaliveAt = 0;
  private hasMedia = false;

  private readonly listeners = new Set<GroupCallListener>();
  private readonly audioListeners = new Set<GroupCallAudioListener>();
  private readonly videoListeners = new Set<GroupCallVideoListener>();

  private readonly handles: unknown[] = [];
  private exitRetries = 0;
  /** 退出重发的完成回调；收到 `0x12` 时调用。 */
  private exitDone: (() => void) | null = null;

  constructor(options: GroupCallSessionOptions) {
    this.opts = options;
    this.timers = options.timers ?? realGroupTimers;
    this.groupId = options.groupId;
    this.stream = options.stream ?? null;
  }

  // ─────────────────────────── 生命周期 ───────────────────────────

  /**
   * 发起：开房 → 多端同步 → 邀请 → 绑定 UDP → 开始定时器。
   *
   * 失败时房间会泄漏在服务端（到期自清，无副作用），调用方不必回收。
   */
  async start(): Promise<GroupCallSnapshot> {
    if (this.state !== 'idle') throw new Error(`群通话已在 ${this.state} 状态`);
    if (this.opts.targetUids.length === 0) throw new Error('至少需要一个邀请目标');

    this.setState('calling');
    try {
      const { room } = await this.opts.signaling.create({
        selfUid: this.opts.selfUid,
        groupId: this.groupId,
      });
      this.k1 = room.authKey;
      this.ownerUin = room.ownerUin;
      this.server = pickServer(room.servers);

      // 多端同步：让手机端也响铃。失败不影响主链路。
      try {
        await this.opts.signaling.multiTerminalSync({
          authKey: room.authKey,
          groupId: this.groupId,
        });
      } catch (error) {
        this.opts.logger?.warn?.('群通话多端同步失败', { error: String(error) });
      }

      if (!this.server) throw new Error('开房回包里没有可用的服务器地址');

      await this.opts.transport.bind();
      this.opts.transport.onMessage((data, from) => this.onPacket(data, from));
      this.opts.transport.onError((error) => {
        this.opts.logger?.warn?.('群通话 UDP 错误', { error: error.message });
      });

      this.startTimers();
      // 抓包顺序：开房 → 多端同步 → GCS 入房 → ACK + 0x25 → 邀请。
      // 邀请不能早于主叫的 GCS 入房，否则对端已经振铃、主叫还未进入房间。
      this.sendEntry();
      this.emit();
      return this.snapshot();
    } catch (error) {
      this.fail('connect_fail');
      throw error;
    }
  }

  /** 挂断：发 `0x11` 并重发直到收到 `0x12`，然后收尾。 */
  async hangup(): Promise<void> {
    if (this.state === 'idle' || this.state === 'ended' || this.state === 'failed') return;
    this.setState('ending');

    const key = this.currentKey();
    if (key && this.server) {
      // 退出包要**重发到收到 0x12 应答**（抓包里连发 5 次、间隔 ~100ms）。
      // 之前的实现发完第一条就 `finish()` 关掉 socket，后面 9 次全丢 ——
      // 服务端收不到退出，房间一直占着，下一次通话的邀请就进不来。
      // 所以这里等到重发结束（或收到应答）再收尾。
      await this.sendExitAndWait(key);
    }

    // 退出包发完（或收到 0x12）后再停定时器并收尾。
    this.stopTimers();
    this.finish('hangup');
  }

  /** 发退出包并等待，直到收到 `0x12` 或重发次数用尽。 */
  private sendExitAndWait(key: Uint8Array): Promise<void> {
    return new Promise((resolve) => {
      this.exitRetries = 0;
      this.exitDone = resolve;
      const tick = () => {
        if (this.exitRetries >= EXIT_RETRY_MAX) {
          this.exitDone = null;
          resolve();
          return;
        }
        this.exitRetries += 1;
        this.sendRelay(
          buildGroupExit({
            route: this.nextRoute(),
            ownerUin: this.opts.selfUin,
            stream: this.stream!,
            key,
          }),
        );
        this.timers.setTimeout(tick, EXIT_RETRY_MS);
      };
      tick();
    });
  }

  // ─────────────────────────── 麦克风 / 摄像头 ───────────────────────────

  /** 开关自己的麦克风（`0x73`，目标为空 = 操作自己）。 */
  setMic(muted: boolean): void {
    const key = this.currentKey();
    if (!key) return;
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

  /** 静音别人（`0x73` 带目标 uin）—— 群通话独有的管理能力。 */
  muteMember(uin: number, muted: boolean): void {
    const key = this.currentKey();
    if (!key) return;
    this.sendRelay(
      buildGroupMicState({
        route: this.nextRoute(),
        ownerUin: this.opts.selfUin,
        stream: this.stream!,
        key,
        muted,
        targetUin: uin,
      }),
    );
  }

  /** 摄像头开关只改本端状态：真正的画面推送由媒体层按需发。 */
  setCamera(on: boolean): void {
    this.cameraOn = on;
    this.emit();
  }

  // ─────────────────────────── 媒体 ───────────────────────────

  /**
   * 推一帧 PCM（640 字节，16 kHz 单声道）。
   *
   * 编码后包成 `0x17` 发出。静音时直接丢弃 —— 服务端不替我们做静音。
   */
  async pushAudio(pcm: Uint8Array): Promise<void> {
    if (this.state !== 'connected' && this.state !== 'connecting') return;
    if (this.micMuted || !this.stream) return;
    if (pcm.length !== FRAME_SAMPLES * 2) {
      throw new RangeError(`一帧必须是 ${FRAME_SAMPLES * 2} 字节 PCM，收到 ${pcm.length}`);
    }

    const opus = await this.opts.codec.encode(pcm);
    this.sendRelay(
      buildGroupAudioFrame({
        route: this.nextRoute(),
        ownerUin: this.opts.selfUin,
        stream: this.stream!,
        seq: this.mediaSeq,
        frameIndex: this.frameIndex,
        sampleTs: this.sampleTs,
        opus,
      }),
    );
    this.mediaSeq += 1;
    this.frameIndex = (this.frameIndex + 1) & 0xff;
    this.sampleTs += FRAME_SAMPLES;
  }

  /** 推一帧 H.264 Annex B（已编码），按上限切片后发 `0x17`。 */
  pushVideoFrame(data: Uint8Array, keyframe = hasIdrNal(data)): void {
    if (!this.cameraOn || !this.stream) return;
    const packets = buildGroupVideoFragments({
      route: this.nextRoute(),
      ownerUin: this.opts.selfUin,
      stream: this.stream,
      seq: this.mediaSeq,
      data,
      keyframe,
    });
    for (const packet of packets) this.sendRelay(packet);
    this.mediaSeq += packets.length;
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
        stream: this.stream!,
        key,
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
      members: [...this.members.values()].sort((a, b) => a.uin - b.uin),
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
    if (data.length < 9) return;
    if (data[0] === 0x28) this.onGcsPacket(data);
    else if (data[0] === 0x02) this.onRelayPacket(data);
  }

  private onGcsPacket(data: Uint8Array): void {
    const packet = parseGroupGcsPacket(data);
    if (!packet) return;

    this.lastKeepaliveAt = this.timers.now();

    // k2 下发：认证成功后服务端从 body.f3.f2 给一把，只给一次。
    const key = extractGroupSessionKey(packet.body);
    if (key) {
      this.k2 = key;
      this.respondGcs(packet.head);
      this.onEntryResponse(packet.head);
      return;
    }

    // 其余都是保活 / 状态推送，一律应答。
    this.respondGcs(packet.head);
    this.onEntryResponse(packet.head);
  }

  /** 应答一条 s2c `0x28`。 */
  private respondGcs(received: Parameters<typeof buildGroupGcsAck>[1]): void {
    // 第一次应答时用服务端给本端的会话 ID 建立自己的序列。
    if (!this.gcsAckStarted) {
      this.gcsSessionId = received.sessionId + 1;
      this.gcsSeq = received.seq;
      this.gcsAckStarted = true;
    }
    this.gcsSeq += 1;
    const packet = buildGroupGcsAck(
      { key: this.currentKey() ?? undefined, sessionId: this.gcsSessionId, seq: this.gcsSeq },
      received,
    );
    this.sendRaw(packet);
  }

  private onRelayPacket(data: Uint8Array): void {
    const packet = parseGroupRelay(data);
    if (!packet) return;

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
        this.exitRetries = EXIT_RETRY_MAX;
        this.exitDone?.();
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
    const state = parseGroupMemberState(packet.body);
    if (state) {
      const member = this.members.get(state.uin);
      if (state.event === GroupMemberEvent.leave) {
        if (state.uin !== this.opts.selfUin) {
          this.members.delete(state.uin);
          this.videoAssembler.reset(state.uin);
        }
      } else {
        this.members.set(state.uin, {
          uin: state.uin,
          uid: member?.uid ?? null,
          video: state.video,
          muted: state.muted,
          self: state.self,
          joinedAt: member?.joinedAt ?? this.timers.now(),
        });
      }
      this.emit();
    }

    this.sendRelay(
      buildGroupMemberStateAck({
        route: packet.route,
        ownerUin: this.opts.selfUin,
        stream: this.stream!,
      }),
    );
    // 自己的「房间就绪」不发 self-only 列表；远端进入、状态变化或离开后，
    // 都按最新成员表重发订阅。远端刚加入时尤其不能漏掉，否则看不到对方的流。
    if (state && state.uin !== this.opts.selfUin) {
      this.subscribeStreams();
    }
  }

  private onCameraState(packet: { route: number; body: Uint8Array }): void {
    const state = parseGroupCameraState(packet.body);
    if (state) {
      const member = this.members.get(state.uin);
      if (member) {
        member.video = state.on;
        this.emit();
      }
    }
    this.sendRelay(
      buildGroupAckRaw(packet.route, this.opts.selfUin, this.stream!, GroupRelayCmd.cameraStateAck),
    );
  }

  private onAuthRsp(packet: { body: Uint8Array }): void {
    if (!parseGroupAuthRsp(packet.body).ok) {
      this.fail('connect_fail');
      return;
    }
    if (this.state === 'calling') this.setState('connecting');
    // 认证成功后立刻订阅成员流。不发这条服务端不会把别人的媒体转给我们，
    // 我们自己的上行也不会被转发（实机抓包确认：对端发了 0x13 才有 0x18）。
    this.subscribeStreams();
  }

  private onMedia(packet: { ownerUin: number; body: Uint8Array }): void {
    const header = parseGroupMediaHeader(packet.body);
    if (!header) return;

    if (!this.hasMedia) {
      this.hasMedia = true;
      if (this.state === 'connecting') this.setState('connected');
    }

    if (header.track === GroupTrack.audio) {
      const frame = parseGroupAudioFrame(packet.body);
      // 成员信息包（fragmentFlag = 0x10）没有有效载荷，跳过。
      if (!frame || frame.fragmentFlag === GroupAudioFragmentFlag.memberInfo) return;
      void this.emitAudio(frame.payload, packet.ownerUin);
      return;
    }

    const fragment = parseGroupVideoFragment(packet.body);
    if (!fragment) return;
    const frame = this.videoAssembler.push(packet.ownerUin, fragment);
    if (!frame) return;
    const at = this.timers.now();
    // 调试：打印帧头，确认是不是关键帧（SPS 67 / IDR 65）
    const head = [...frame.data.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.opts.logger?.info?.('群通话视频帧', {
      len: frame.data.length,
      fragments: frame.fragments,
      keyframe: frame.keyframe,
      head,
    });
    for (const listener of this.videoListeners) {
      listener(frame.data, { uin: frame.ownerUin, keyframe: frame.keyframe }, at);
    }
  }

  private async emitAudio(opus: Uint8Array, uin: number): Promise<void> {
    try {
      const pcm = await this.opts.codec.decode(opus);
      const at = this.timers.now();
      for (const listener of this.audioListeners) listener(pcm, uin, at);
    } catch (error) {
      this.opts.logger?.warn?.('群通话音频解码失败', { error: String(error) });
    }
  }

  // ─────────────────────────── 发送 ───────────────────────────

  /**
   * 订阅成员流（`0x13`）。成员表变化时也要重发。
   *
   * **不订阅就收不到任何媒体** —— 对端发了 `0x13` 才有 `0x18` 下行流；
   * 不发的话服务端根本不会把别人的流转给我们（实机抓包确认）。
   *
   * 密钥用当前可用的那把：k2 下发后用它，否则用 k1。之前这里写死 `this.k2`，
   * 而 k2 在某些房间根本不下发，导致订阅永远发不出去。
   */
  private subscribeStreams(): void {
    const key = this.currentKey();
    if (!this.stream || !key) return;
    this.sendRelay(
      buildGroupStreamSubscribe({
        route: this.nextRoute(),
        ownerUin: this.opts.selfUin,
        stream: this.stream!,
        key,
        memberUins: [...this.members.keys()],
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
    this.gcsSeq = 265;
    this.sendRaw(
      buildGroupGcsEntry({
        sessionId: this.gcsSessionId,
        seq: this.gcsSeq,
        selfUin: this.opts.selfUin,
        key: this.k1,
        body: this.opts.gcsEntryBody,
      }),
    );
  }

  /**
   * 首次 GCS 回包已 ACK 后：还原流标识 → 发 `0x25` → 发 `SsoInviteRoom`。
   *
   * **流标识由服务端分配**：应答 head 的 `f4` 是流标识前 4 字节、`f5` 的第 5-6
   * 字节是流标识第 5-6 字节（`f5 >> 16`），末字节恒 0。两通抓包各自验证过。
   */
  private onEntryResponse(received?: GroupGcsHead): void {
    if (this.entryResponseReceived || this.state === 'ending' || this.state === 'ended') return;
    this.entryResponseReceived = true;

    // 服务端在入房应答里下发流标识，后续所有 0x02 包都用它。
    if (received && !this.opts.stream) {
      this.stream = streamFromGcsFields(received.f4, received.f5);
      this.opts.logger?.info?.('群通话流标识已分配', {
        stream: [...this.stream].map((b) => b.toString(16).padStart(2, '0')).join(''),
      });
    }

    // 首次 0x25 必须使用开房回包的 k1；即使首个 0x28 已经下发 k2，也不能提前切换。
    this.authenticate(this.k1);
    if (this.inviteStarted) return;
    this.inviteStarted = true;
    const authKey = this.k1;
    if (!authKey) return;
    void this.opts.signaling
      .invite({ targetUids: this.opts.targetUids, authKey, groupId: this.groupId })
      .catch((error: unknown) => {
        this.opts.logger?.warn?.('群通话邀请失败', { error: String(error) });
        this.fail('error');
      });
  }

  // ─────────────────────────── 定时器 ───────────────────────────

  private startTimers(): void {
    this.lastKeepaliveAt = this.timers.now();
    this.handles.push(
      this.timers.setInterval(() => this.checkKeepalive(), KEEPALIVE_WATCH_MS),
      this.timers.setInterval(() => void this.refreshMembers(), QUERY_MEMBERS_MS),
      this.timers.setTimeout(() => {
        if (this.state === 'calling') this.fail('timeout');
      }, RING_TIMEOUT_MS),
    );
  }

  private stopTimers(): void {
    for (const handle of this.handles) {
      this.timers.clearInterval(handle);
      this.timers.clearTimeout(handle);
    }
    this.handles.length = 0;
  }

  private checkKeepalive(): void {
    if (this.state !== 'connecting' && this.state !== 'connected') return;
    if (this.timers.now() - this.lastKeepaliveAt > KEEPALIVE_TIMEOUT_MS) {
      this.fail('connect_fail');
    }
  }

  /** 周期查房间成员，补 `uin ↔ uid` 映射（`0x19` 里只有 uin）。 */
  private async refreshMembers(): Promise<void> {
    if (!this.k1 || !this.ownerUin) return;
    try {
      const room = await this.opts.signaling.query({
        groupId: this.groupId,
        authKey: this.k1,
      });
      for (const member of room.members) {
        const existing = this.members.get(member.uin);
        if (existing) {
          existing.uid = member.uid ?? existing.uid;
        } else {
          this.members.set(member.uin, {
            uin: member.uin,
            uid: member.uid,
            video: false,
            muted: false,
            self: member.uin === this.opts.selfUin,
            joinedAt: this.timers.now(),
          });
        }
      }
      this.emit();
    } catch (error) {
      this.opts.logger?.warn?.('群通话成员查询失败', { error: String(error) });
    }
  }

  // ─────────────────────────── 状态 ───────────────────────────

  private setState(state: GroupCallState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit();
  }

  private fail(reason: GroupCallEndReason): void {
    this.stopTimers();
    this.finish(reason, 'failed');
  }

  private finish(reason: GroupCallEndReason, state: GroupCallState = 'ended'): void {
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

/** 组一个通用应答（`0x65` 等），避免为了一个包再引一个导出。 */
function buildGroupAckRaw(
  route: number,
  ownerUin: number,
  stream: Uint8Array,
  cmd: number,
): Uint8Array {
  const body = new Uint8Array(16);
  body.set(stream, 0);
  body[7] = 0x01;
  body[11] = 0x01;
  return buildGroupRelay({ route, cmd, ownerUin, body });
}

// 供调用方构造流标识时用的长度（7 字节）。
export const GROUP_STREAM_LEN = 7;
// 让类型检查器知道这个常量被引用了（会话密钥长度由协议层统一定义）。
export const SESSION_KEY_LEN = GROUP_SESSION_KEY_LEN;
