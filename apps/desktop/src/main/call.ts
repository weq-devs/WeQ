/**
 * 语音通话的主进程编排。
 *
 * `@weq/service` 的 `CallSession` 只描述状态机与报文编排，UDP、编解码、信令
 * 三样都靠注入。这个模块负责把真实实现接上：
 *
 *   - **UDP**：`node:dgram` 的 udp4 套接字，绑定随机端口；
 *   - **编解码**：nt_helper 的 `openCallCodec` / `encodeCallFrame` / `decodeCallFrame`
 *     （用的是 QQ 自带的那一版 Opus，标准 libopus 与它不互通）；
 *   - **信令**：`@weq/protocol` 的 `startC2CCall` / `endC2CCall`，借已登记的
 *     SSO 会话发包。
 *
 * 同一进程同时只允许一路通话（服务端也只给一路），所以这里是一个单例管理器。
 *
 * ⚠️ 与「在线语音转写」不同：通话的响应全部走**我们自己的 UDP 套接字**，
 * 不需要网卡旁路抓包 —— 房间事件、音频都由服务端直接发到这条 socket 上。
 */

import dgram from 'node:dgram';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { NtHelperBinding } from '@weq/native';
import type { Platform } from '@weq/platform';
import {
  CallSession,
  getLogger,
  protocolSignaling,
  type CallAudioCodec,
  type CallRecordingConfig,
  type CallSnapshot,
  type CallState,
  type UdpTransport,
  type VideoStreamInfo,
  type VideoFramePayload,
} from '@weq/service';
import { CallRecorder, type RecordingSnapshot } from './call_recorder';
import { NativeVideoEncoder } from './call_video_encoder';
import {
  CallRecordingStore,
  recordingsRootFor,
  type CallRecordingEntry,
} from './call_recording_store';
import {
  LinuxSystemAudioCapture,
  systemAudioCapability,
  type SystemAudioCapability,
} from './call_system_audio';
import type { VideoProfile, VideoSource } from '../shared/call_video_profile';

const logger = getLogger().child({ scope: 'call' });

/**
 * 补发缓存上限（帧）。
 *
 * 实测对端关键帧间隔约 17 秒（15 fps ≈ 255 帧），所以 600 帧足够覆盖一整段。
 * 平均每帧 2 KB 时峰值约 1.2 MB —— 只为「订阅晚到」这一种情况准备，值得。
 * 超出说明码流异常（关键帧间隔极大），整段作废、等下一个关键帧。
 */
const REPLAY_FRAMES = 600;

// ─────────────────────────── UDP ───────────────────────────

/** `node:dgram` 的 udp4 套接字适配成 `CallSession` 要的形状。 */
class NodeUdpTransport implements UdpTransport {
  private socket: dgram.Socket | null = null;
  private p2pSocket: dgram.Socket | null = null;

  async bind(): Promise<void> {
    const open = (): Promise<dgram.Socket> =>
      new Promise((resolve, reject) => {
        const socket = dgram.createSocket({ type: 'udp6', reuseAddr: false, ipv6Only: false });
        socket.once('error', reject);
        socket.bind(0, () => {
          socket.removeListener('error', reject);
          resolve(socket);
        });
      });
    try {
      const [control, p2p] = await Promise.all([open(), open()]);
      this.socket = control;
      this.p2pSocket = p2p;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /**
   * 绑定后的本地端口。
   *
   * `CallSession` 要用它填 `bt=25`（向服务端公告本端 P2P 端口）—— 公告的端口必须
   * 就是真正收发媒体这个 socket 的端口，否则对端打洞打不通。
   */
  localPort(): number {
    if (!this.p2pSocket) return 0;
    try {
      return this.p2pSocket.address().port;
    } catch {
      // 已关闭 / 未绑定。
      return 0;
    }
  }

  send(data: Uint8Array, port: number, address: string): void {
    const socket = [8000, 8001, 8800].includes(port) ? this.socket : this.p2pSocket;
    if (!socket) return;
    // 直接拷一份：dgram 的回调可能在原缓冲被复写之后才跑。
    const buffer = Buffer.from(data);
    // udp6 套接字发纯 IPv4 目标时，部分平台需要显式映射成 ::ffff: 形式。
    const target = address.includes(':') ? address : `::ffff:${address}`;
    socket.send(buffer, 0, buffer.length, port, target, (error) => {
      // 发送失败以前是静默吞掉的：地址不可达 / 套接字类型不匹配时
      // 上层完全看不出「对方为什么收不到」。这里至少留一条日志。
      if (error) {
        logger.warn('UDP 发送失败', { address, port, error: error.message });
      }
    });
  }

  close(): void {
    const sockets = [this.socket, this.p2pSocket].filter(
      (socket): socket is dgram.Socket => !!socket,
    );
    this.socket = null;
    this.p2pSocket = null;
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // 已关闭 / 未绑定，忽略。
      }
    }
  }

  onMessage(handler: (data: Uint8Array, from: { address: string; port: number }) => void): void {
    this.watch((socket) => {
      socket.on('message', (msg, rinfo) => {
        handler(new Uint8Array(msg), { address: rinfo.address, port: rinfo.port });
      });
    });
  }

  onError(handler: (error: Error) => void): void {
    this.watch((socket) => socket.on('error', handler));
  }

  /**
   * 监听器要在 `bind()` 之前挂上（会话是先 onMessage 再 bind），而那时 socket
   * 还不存在 —— 所以先排队，等绑定成功再挂。
   */
  private pending: Array<(socket: dgram.Socket) => void> = [];
  private watch(register: (socket: dgram.Socket) => void): void {
    if (!this.socket) {
      this.pending.push(register);
      return;
    }
    register(this.socket);
    if (this.p2pSocket) register(this.p2pSocket);
  }

  /** 绑定完成后把排队的监听器挂上。 */
  attach(): void {
    const sockets = [this.socket, this.p2pSocket].filter(
      (socket): socket is dgram.Socket => !!socket,
    );
    for (const register of this.pending) {
      for (const socket of sockets) register(socket);
    }
    this.pending = [];
  }
}

// ─────────────────────────── 编解码 ───────────────────────────

/** nt_helper 侧的 Opus 编解码，转成 `CallSession` 要的异步形状。 */
class NativeCallCodec implements CallAudioCodec {
  constructor(
    private readonly nt: NtHelperBinding,
    private readonly modulesDir: string,
  ) {}

  async open(): Promise<void> {
    await this.nt.openCallCodec(this.modulesDir);
  }

  async encode(pcm: Uint8Array): Promise<Uint8Array> {
    const out = this.nt.encodeCallFrame(Buffer.from(pcm));
    return new Uint8Array(out);
  }

  async decode(opus: Uint8Array): Promise<Uint8Array> {
    const out = this.nt.decodeCallFrame(Buffer.from(opus));
    return new Uint8Array(out);
  }

  close(): void {
    this.nt.closeCallCodec();
  }
}

// ─────────────────────────── 管理器 ───────────────────────────

/** 界面要的一份通话描述。 */
export interface ActiveCallInfo extends CallSnapshot {
  /** 目标显示名（拿不到时为空串）。 */
  peerName: string;
  /** 目标头像 URL。 */
  peerAvatar: string;
  /** 通话背景静态图（个性装扮 appId 17）；空表示没设。 */
  backgroundUrl: string;
  /** 通话背景动态版。非空时界面优先播它。 */
  backgroundVideoUrl: string;
  /** 已接通时长（秒）；未接通为 0。 */
  durationSec: number;
  /** 正在录音时的状态；没在录为 null。 */
  recording: RecordingSnapshot | null;
}

export interface StartCallParams {
  pid: number;
  selfUin: string;
  selfUid: string;
  /** 会话类型。目前只有私聊，字段先留好给群通话。 */
  kind?: 'c2c' | 'group';
  /** 通话媒体类型。`video` 只影响信令档位，画面要另外开摄像头。 */
  media?: 'audio' | 'video';
  /** 会话标识（私聊 = 对方 uid，群聊 = 群号）。留空时用 peerUid 兜底。 */
  conv?: string;
  peerUin: string;
  peerUid: string;
  peerName?: string;
  peerAvatar?: string;
  /** 通话背景（由调用方先用 `ensureCallBackground` 取得；拿不到就留空）。 */
  backgroundUrl?: string;
  backgroundVideoUrl?: string;
  /** 录音设置（取设置页当前值；不传则按默认「双方混音、不录电脑声音」）。 */
  recordingConfig?: CallRecordingConfig;
  /**
   * 禁用 P2P 直连，媒体全程走服务端中继（排障开关，见设置项 `callDisableP2P`）。
   *
   * 必须在**发起时**定下：`CallSession` 的发送目标在会话生命周期内按媒体路径
   * 变化，中途改会让已在途的包走两条路。
   */
  disableP2P?: boolean;
}

export type CallEvent =
  | { type: 'state'; call: ActiveCallInfo }
  | { type: 'audio'; pcm: Uint8Array }
  /** 对端一帧视频（Annex B 裸流）。 */
  | {
      type: 'video';
      hevc: Uint8Array;
      timestamp: number;
      keyframe: boolean;
      /**
       * 16 位帧序号 `((fidx - 1) << 8) | gidx`。
       *
       * 渲染层要靠它判断「喂给解码器的帧是否连续」—— HEVC 的 P 帧依赖前序参考
       * 帧，跳过若干帧后继续喂 delta 帧会让硬解输出错乱的 YUV（表现为整屏纯绿），
       * 且要等到下一个关键帧才恢复。见 useCallVideo 的 continuity 检查。
       */
      frameIndex: number;
      info: VideoStreamInfo | null;
    }
  /** 录音收尾完成（含内部收尾：对端挂断 / 被踢 / 崩溃）。 */
  | { type: 'recording'; entry: CallRecordingEntry }
  | { type: 'error'; message: string };

/**
 * 通话管理器。单例：同一时刻只允许一路通话。
 *
 * 事件通过 `EventEmitter` 往外推，「状态」与「对端音频」两条流，主进程再包成
 * tRPC subscription 给渲染层。
 */
export class CallManager extends EventEmitter {
  private session: CallSession | null = null;
  private info: ActiveCallInfo | null = null;
  /** UDP 套接字。`CallSession` 只认 `UdpTransport` 接口，这里留一份方便收尾。 */
  private transport: NodeUdpTransport | null = null;
  /** 每秒推进一次通话时长。通话中状态不变，光靠状态推送时长会停在 00:00。 */
  private durationTimer: ReturnType<typeof setInterval> | null = null;

  /** 视频编码器（只有视频通话才非 null）。 */
  private videoEncoder: NativeVideoEncoder | null = null;
  /**
   * 从**最近一个关键帧**开始的一段连续帧（新订阅者补发用）。
   *
   * ⚠️ **只补关键帧是不够的。** 2026-10-26 实测：渲染层订阅比收帧晚约 1.9 秒，
   * 补发关键帧（帧 0）之后紧接着喂实时帧（帧 29），中间 1~28 缺失。HEVC 的 P 帧
   * 依赖前序参考帧，硬解拒绝这些 delta 后内部状态被污染，输出错乱的 YUV ——
   * 整屏纯绿，直到下一个关键帧（约 15 秒）才恢复。
   *
   * 所以这里缓存「关键帧 + 其后所有帧」的连续片段，订阅时整段补发，渲染层就能
   * 从头连续解码。上限 {@link REPLAY_FRAMES} 帧，超出就丢最旧的（那些帧的参考
   * 链已经断了，补发也没用）。
   */
  private replayBuffer: VideoFramePayload[] = [];
  /** 当前这通电话的录音设置（发起时取一次，通话中改设置不影响进行中的录音）。 */
  private recordingConfig: CallRecordingConfig = { mode: 'mixed', systemAudio: false, dir: null };
  private recorder: CallRecorder | null = null;
  /** 录音记录（落盘后才有；收尾时用它回报给界面）。 */
  private recordingEntry: CallRecordingEntry | null = null;
  /** 当前录音所在的索引（收尾时补时长）。 */
  private recordingStore: CallRecordingStore | null = null;
  /** 会话类型与标识（写进录音索引，气泡回放据此匹配）。 */
  private kind: 'c2c' | 'group' = 'c2c';
  private conv = '';
  /** Linux 的监视源采集。Windows 走渲染层，这里为 null。 */
  private systemCapture: LinuxSystemAudioCapture | null = null;

  constructor(
    private readonly nt: NtHelperBinding,
    private readonly platform: Platform,
  ) {
    super();
  }

  /** 当前通话（没有则 null）。 */
  current(): ActiveCallInfo | null {
    return this.info;
  }

  /**
   * 取一段**从关键帧开始、帧序号连续**的帧，供新建立的渲染层订阅补发。
   *
   * 渲染层是在「对端开始发视频」的状态推送之后才订阅 `onCallVideo` 的，而首个
   * 关键帧通常已经过去。**只补关键帧不够**：跳帧会让硬解输出错乱（整屏纯绿），
   * 必须把关键帧之后的帧一并补上，让渲染层从头连续解码。详见 `replayBuffer`。
   *
   * 返回空数组表示还没有可用的起点（还没收到过关键帧）。
   */
  replayFrames(): VideoFramePayload[] {
    return this.replayBuffer;
  }

  /** 发起一路通话。已有通话在跑时直接报错，由界面提示先挂断。 */
  async start(params: StartCallParams): Promise<ActiveCallInfo> {
    if (this.session) throw new Error('当前已有通话，请先挂断');

    const modulesDir = this.resolveModulesDir();
    if (!modulesDir) throw new Error('找不到 QQ 的 AVSDK 目录，无法初始化语音编解码器');

    const transport = new NodeUdpTransport();
    const codec = new NativeCallCodec(this.nt, modulesDir);
    // 视频编码器只在发起视频通话时建：它要打开 QQ 自带的那一版 x265，
    // 纯语音通话没必要付这个开销。
    const videoEncoder =
      params.media === 'video' ? new NativeVideoEncoder(this.nt, modulesDir) : null;
    if (videoEncoder) await videoEncoder.open();
    this.videoEncoder = videoEncoder;
    const session = new CallSession({
      selfUin: params.selfUin,
      selfUid: params.selfUid,
      peerUin: params.peerUin,
      peerUid: params.peerUid,
      media: params.media ?? 'audio',
      // 排障开关：强制走中继。发起时定一次，通话中不再变。
      disableP2P: params.disableP2P === true,
      signaling: protocolSignaling(this.nt, params.pid),
      transport: {
        bind: async () => {
          await transport.bind();
          transport.attach();
        },
        // 必须透传：会话靠它填 bt=25 的 P2P 端口，漏掉这一行整条 P2P 通路就断了。
        localPort: () => transport.localPort(),
        send: (data, port, address) => transport.send(data, port, address),
        close: () => transport.close(),
        onMessage: (handler) => transport.onMessage(handler),
        onError: (handler) => transport.onError(handler),
      },
      codec,
      // 视频编码器：只有发起视频通话时才建。采在渲染层、编在主进程，
      // 中间靠 pushVideoFrame 把 I420 推进来。
      videoEncoder: videoEncoder ?? undefined,
      logger,
    });

    this.session = session;
    this.transport = transport;
    this.kind = params.kind ?? 'c2c';
    this.conv = params.conv ?? params.peerUid ?? '';
    this.recordingConfig = params.recordingConfig ?? this.recordingConfig;
    this.recordingEntry = null;
    this.info = {
      ...session.snapshot(),
      peerName: params.peerName ?? '',
      peerAvatar: params.peerAvatar ?? '',
      backgroundUrl: params.backgroundUrl ?? '',
      backgroundVideoUrl: params.backgroundVideoUrl ?? '',
      durationSec: 0,
      recording: null,
    };

    session.onStateChange((snapshot) => {
      if (snapshot.state === 'connected') this.startDurationTicker();
      this.publishState(snapshot);
    });
    session.onAudio((pcm) => {
      // 对端音频同时喂录音（混音用），再照常推给渲染层播放。
      this.recorder?.pushPeer(pcm);
      this.emit('event', { type: 'audio', pcm } satisfies CallEvent);
    });
    session.onVideo((frame) => {
      // **每一帧都推，不要按 fidx 过滤。**
      //
      // 早先这里按「fidx === 1 才是基础层」丢弃 fidx>=2 的帧，前提是错的：fidx
      // 其实是**16 位帧序号的高字节**（每 256 帧 +1），不是 SVC 层号。于是通话
      // 进行到第 256 帧（10 fps 下约 25 秒）之后，`isBaseLayer` 恒为 false，
      // 而标记又停在 true 且不再更新 —— 后续每一帧都被静默丢掉，画面永久冻结。
      // 真机日志里 `g=249/f=1 → g=43/f=2` 的序号连续性就是证据。
      if (!frame.hevc) return;
      this.rememberForReplay(frame);
      this.emit('event', {
        type: 'video',
        hevc: frame.hevc,
        timestamp: frame.timestamp,
        keyframe: frame.isKeyframe,
        frameIndex: frame.frameIndex,
        info: frame.info,
      } satisfies CallEvent);
    });

    // `start()` 自己会吞掉异常并收敛到 `failed`，所以这里不会抛 —— 但它**不**
    // 保证成功。失败时状态监听器已经把 `info` 清空（`cleanup`），原先再读
    // `this.info!` 就拿到 null，调用方随后取 `call.roomId` 便抛
    // 「Cannot read properties of null」，把编解码器 / UDP / 信令的真实原因
    // 全盖掉了。所以先判状态，把 `lastError` 原样抛给界面。
    try {
      await session.start();
      const snapshot = session.snapshot();
      if (snapshot.state === 'failed') {
        throw new Error(snapshot.lastError ?? '无法建立通话');
      }
      this.publishState(snapshot);
      if (!this.info) throw new Error('通话未建立就被结束');
      return this.info;
    } catch (error) {
      // 兜底：异常路径下 `publishState` 可能没跑到，会话就会一直留在
      // `this.session` 上，让下一次发起被「当前已有通话」挡掉。
      this.cleanup();
      throw error;
    }
  }

  /** 主动挂断。 */
  async hangup(): Promise<void> {
    const session = this.session;
    if (!session) return;
    // 先收录音再拆会话：`session.hangup()` 之后不会再有音频帧进来，录音的时长
    // 才是准的；反过来则会在最后一帧之后继续补静音。
    await this.finalizeRecording();
    await session.hangup();
    this.cleanup();
  }

  /**
   * 渲染层推来一帧 I420（摄像头采集）。
   *
   * 只有视频通话且本端摄像头开着时才吃 —— 关摄像头后队列里的旧帧也不该再发。
   */
  pushVideoFrame(y: Uint8Array, u: Uint8Array, v: Uint8Array): boolean {
    const session = this.session;
    if (!session) return false;
    if (!session.snapshot().videoSending) return false;
    const encoder = this.videoEncoder;
    if (!encoder) {
      logger.warn('pushVideoFrame：本端没有视频编码器');
      return false;
    }
    // tRPC 走 JSON 时 Uint8Array 可能变成普通对象；这里统一归一化，
    // 否则 `Buffer.from(obj)` 会得到空/错数据，编码器静默不出帧。
    const norm = (value: unknown): Uint8Array => {
      if (value instanceof Uint8Array) return value;
      const obj = value as { type?: string; data?: number[]; length?: number };
      if (obj?.type === 'Buffer' && Array.isArray(obj.data)) return Uint8Array.from(obj.data);
      if (typeof obj?.length === 'number') {
        const out = new Uint8Array(obj.length);
        for (let i = 0; i < obj.length; i++) {
          out[i] = (value as unknown as Record<number, number>)[i] ?? 0;
        }
        return out;
      }
      return new Uint8Array(0);
    };
    const ny = norm(y);
    const nu = norm(u);
    const nv = norm(v);
    encoder.pushFrame({ y: ny, u: nu, v: nv });
    return true;
  }

  /**
   * 开 / 关本端摄像头。
   *
   * 只发控制信令并切换发送状态；画面要靠 `CallSession` 里注入的编码器吐帧，
   * 采集由渲染层负责。
   */
  setCamera(enabled: boolean): boolean {
    const session = this.session;
    if (!session) return false;
    const before = session.snapshot();
    session.setCamera(enabled);
    const after = session.snapshot();
    logger.info('切换摄像头', {
      enabled,
      state: before.state,
      videoSending: `${before.videoSending} -> ${after.videoSending}`,
      roomId: after.roomId,
    });
    // 关摄像头时顺手把采集源复位回摄像头：下次再打开应该回到摄像头，而不是
    // 接着共享屏幕（用户点「关摄像头」的意思是「不发了」，不是「换成共享」）。
    if (!enabled) void this.resetVideoSource();
    return true;
  }

  /**
   * 切换采集源：摄像头 ↔ 屏幕共享。
   *
   * **协议层完全不做区分** —— 屏幕共享就是一路普通主视频流（`0x5b subType=2`），
   * 与摄像头共用同一套 `subType=4` 开关信令、`subType=5` 保活、`bt=31` 状态交换。
   * 对端不会收到「这是屏幕共享」的额外提示（QQ 本体的独立提示要另一套信令，
   * 尚未还原），但对端能看到画面本身。
   *
   * 这里做三件事：
   *
   * 1. 编码器换档位（640×360@300kbps ↔ 1280×720@1.2Mbps）并重开；
   * 2. 告诉 `CallSession` 新的编码规格（`snapshot().videoInfo`）；
   * 3. 如果视频流原本没在发，顺手打开（共享屏幕本身就是要发画面）。
   *
   * 返回实际生效的档位，渲染层据此决定采集尺寸。
   */
  async setVideoSource(source: VideoSource): Promise<VideoProfile | null> {
    const session = this.session;
    const encoder = this.videoEncoder;
    if (!session || !encoder) return null;
    if (session.snapshot().state !== 'connected') {
      logger.warn('切换采集源被拒：通话未接通', { source });
      return null;
    }
    const profile = await encoder.setSource(source);
    // 编码器重建后队列与规格都变了，让会话重新读一次（界面与状态快照都用它）。
    session.setVideoEncoding();
    // 共享屏幕必然要发画面：原本摄像头关着就一起打开。
    if (!session.snapshot().videoSending) session.setCamera(true);
    session.setVideoSource(source);
    logger.info('采集源已切换', {
      source,
      width: profile.width,
      height: profile.height,
      fps: profile.fps,
      bitrateKbps: profile.bitrateKbps,
    });
    return profile;
  }

  /**
   * 渲染层按**源的实际宽高比**算出采集尺寸后回头重设编码器。
   *
   * 共享一块 21:9 的屏幕时渲染层会推出 1280×540 这样的尺寸；编码器必须用同一
   * 个尺寸，否则 `pushFrame` 的平面长度校验不通过、帧会被静默丢掉。
   */
  async resizeVideo(width: number, height: number): Promise<boolean> {
    const encoder = this.videoEncoder;
    const session = this.session;
    if (!encoder || !session) return false;
    await encoder.resize(width, height);
    session.setVideoEncoding();
    return true;
  }

  /** 采集源复位回摄像头（关摄像头 / 通话结束时）。 */
  private async resetVideoSource(): Promise<void> {
    const encoder = this.videoEncoder;
    if (!encoder || encoder.currentSource === 'camera') return;
    await encoder.setSource('camera').catch((error: unknown) => {
      logger.warn('复位采集源失败', { error: error instanceof Error ? error.message : error });
    });
    if (this.session && this.videoEncoder) {
      this.session.setVideoEncoding();
      this.session.setVideoSource('camera');
    }
  }

  /**
   * 界面推来一帧麦克风音频。
   *
   * `muted` 只影响**是否发给对方**：录音始终要这帧（否则静音期间录下来的是
   * 空轨，回放时会听到一段莫名其妙的静音）。
   */
  pushAudio(pcm: Uint8Array, muted = false): void {
    this.recorder?.pushSelf(pcm);
    if (!muted) this.session?.pushAudio(pcm);
  }

  /** 界面推来一帧「电脑正在播放的声音」（Windows 走渲染层采集）。 */
  pushSystemAudio(pcm: Uint8Array): void {
    this.recorder?.pushSystem(pcm);
  }

  /** 当前录音状态；没在录为 null。 */
  recording(): RecordingSnapshot | null {
    return this.recorder?.snapshot() ?? null;
  }

  /** 录音能力（界面据此决定「电脑声音」开关能否开）。 */
  systemAudioCapability(): SystemAudioCapability {
    return systemAudioCapability();
  }

  /**
   * 开始录音。只在**已接通**时允许 —— 没接通时录下来的只有静音，而且用户看到
   * 「录音中」却什么都没录到，比直接拒绝更糟。
   */
  async startRecording(override?: Partial<CallRecordingConfig>): Promise<RecordingSnapshot> {
    if (!this.session) throw new Error('当前没有通话');
    if (this.session.snapshot().state !== 'connected') throw new Error('通话接通后才能录音');
    if (this.recorder) return this.recorder.snapshot();

    const config: CallRecordingConfig = { ...this.recordingConfig, ...override };
    const root =
      config.dir ?? recordingsRootFor(this.platform.appDataRoot(), this.session.snapshot().peerUin);
    const store = new CallRecordingStore(root);
    await store.ensure();

    const startedAt = Date.now();
    const entry = await store.create({
      kind: this.kind,
      conv: this.conv || this.session.snapshot().peerUid || this.session.snapshot().peerUin,
      peerUin: this.session.snapshot().peerUin,
      peerName: this.info?.peerName ?? '',
      startedAt,
      endedAt: startedAt,
      durationSec: 0,
      mode: config.mode,
      systemAudio: config.systemAudio,
    });

    const recorder = new CallRecorder({
      path: join(store.root, entry.fileName),
      mode: config.mode,
      systemAudio: config.systemAudio,
      startedAt,
    });
    recorder.start();
    this.recorder = recorder;
    this.recordingStore = store;
    this.recordingEntry = entry;

    // Linux：主进程直接起 parec 采监视源。Windows 由渲染层采集后推回来，这里不做事。
    if (config.systemAudio && systemAudioCapability() === 'native') {
      const capture = new LinuxSystemAudioCapture({
        onFrame: (pcm) => this.recorder?.pushSystem(pcm),
        onError: (error) => {
          logger.warn('电脑声音采集中断', { error: error.message });
          this.systemCapture?.stop();
          this.systemCapture = null;
          this.emit('event', {
            type: 'error',
            message: '电脑声音采集失败，录音仍在继续（只录通话声音）',
          } satisfies CallEvent);
        },
      });
      if (capture.start()) this.systemCapture = capture;
    }

    logger.info('开始录音', { path: entry.fileName, mode: config.mode });
    this.publishRecording();
    return recorder.snapshot();
  }

  /** 停止录音并落盘收尾。没有在录时返回 null。 */
  async stopRecording(): Promise<CallRecordingEntry | null> {
    const recorder = this.recorder;
    const entry = this.recordingEntry;
    const store = this.recordingStore;
    if (!recorder || !entry) return null;
    this.systemCapture?.stop();
    this.systemCapture = null;
    await recorder.stop();
    const snapshot = recorder.snapshot();
    this.recorder = null;
    this.recordingEntry = null;
    this.recordingStore = null;

    entry.endedAt = Date.now();
    entry.durationSec = snapshot.durationSec;
    // 索引里那条记录是最先写进去的（时长还是 0），这里补上时长与结束时刻。
    await store?.update(entry).catch((error) => {
      logger.warn('更新录音索引失败', { error: error instanceof Error ? error.message : error });
    });
    logger.info('录音结束', { path: entry.fileName, durationSec: snapshot.durationSec });
    this.publishRecording();
    // 内部收尾（对端挂断 / 被踢）时渲染层没有 await 这次调用，必须推一条事件，
    // 否则窗口会以为「没录到音」而自动关掉，录音卡片就永远看不到。
    this.emit('event', { type: 'recording', entry } satisfies CallEvent);
    return entry;
  }

  /** 把录音状态推给界面（通话状态没变，只有录音变了）。 */
  private publishRecording(): void {
    if (!this.info) return;
    this.info = { ...this.info, recording: this.recording() };
    this.emit('event', { type: 'state', call: this.info } satisfies CallEvent);
  }

  /** 录音收尾（挂断 / 崩溃 / 切号三条路径都要走到）。 */
  private async finalizeRecording(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    // 会话可能已经处于终态，`stopRecording` 只依赖 recorder 本身，照常走。
    await this.stopRecording().catch((error) => {
      logger.warn('录音收尾失败', { error: error instanceof Error ? error.message : error });
    });
  }

  /** 进程退出 / 账号切换时强制收尾。 */
  dispose(): void {
    const session = this.session;
    if (!session) return;
    void this.finalizeRecording()
      .catch(() => {})
      .then(() => session.hangup())
      .finally(() => this.cleanup());
  }

  private publishState(snapshot: CallSnapshot): void {
    if (!this.info) return;
    this.info = this.buildInfo(snapshot);
    this.emit('event', { type: 'state', call: this.info } satisfies CallEvent);
    // 通话已经结束：把会话放掉，允许下一次发起。
    if (snapshot.state === 'ended' || snapshot.state === 'failed') {
      this.cleanup();
    }
  }

  /**
   * 把会话快照翻成界面用的形状。
   *
   * 时长是**算出来的**，不能跟着状态变化走：通话中状态一直是 `connected`，
   * 只在接通那一刻发过一次快照，界面上就会一直显示 00:00。所以除了状态推送，
   * 还要有一个每秒一次的计时器（见 {@link startDurationTicker}）。
   */
  private buildInfo(snapshot: CallSnapshot): ActiveCallInfo {
    const connectedAt = snapshot.connectedAt;
    return {
      ...snapshot,
      peerName: this.info?.peerName ?? '',
      peerAvatar: this.info?.peerAvatar ?? '',
      backgroundUrl: this.info?.backgroundUrl ?? '',
      backgroundVideoUrl: this.info?.backgroundVideoUrl ?? '',
      durationSec: connectedAt ? Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)) : 0,
      recording: this.recorder?.snapshot() ?? null,
    };
  }

  /** 每秒把当前时长推一次，只在已接通时跑。 */
  private startDurationTicker(): void {
    if (this.durationTimer) return;
    this.durationTimer = setInterval(() => {
      const session = this.session;
      if (!session) return;
      const snapshot = session.snapshot();
      if (snapshot.state !== 'connected') return;
      if (!this.info) return;
      // 录音时长跟着同一拍走：它也是一秒一变，没必要另起一个定时器。
      this.info = this.buildInfo(snapshot);
      this.emit('event', { type: 'state', call: this.info } satisfies CallEvent);
    }, 1000);
  }

  private stopDurationTicker(): void {
    if (!this.durationTimer) return;
    clearInterval(this.durationTimer);
    this.durationTimer = null;
  }

  private cleanup(): void {
    this.stopDurationTicker();
    // 兜底：对端挂断 / 被踢 / 异常路径都会走到这里，录音必须在这里收尾。
    void this.finalizeRecording();
    // 会话自己会关 socket，但异常路径（订阅断了 / 渲染层崩了）可能没走到，
    // 这里兜一次底：重复 close 是幂等的。
    this.transport?.close();
    this.videoEncoder?.close();
    this.videoEncoder = null;
    this.replayBuffer = [];
    this.session = null;
    this.transport = null;
    this.info = null;
  }

  /**
   * 维护「从关键帧开始的一段连续帧」缓存，供新订阅补发。
   *
   * 见 {@link replayBuffer} 的注释：只补关键帧会让渲染层跳帧喂入，硬解输出
   * 错乱（整屏纯绿）。所以：
   *
   * - 遇到关键帧 → 清空重来（这是新的参考链起点）；
   * - 帧序号不连续 → 同样清空（参考链已断，之前的帧补发也没用）；
   * - 其余帧追加，超过上限丢最旧的。
   */
  private rememberForReplay(frame: VideoFramePayload): void {
    const last = this.replayBuffer[this.replayBuffer.length - 1];
    if (frame.isKeyframe) {
      this.replayBuffer = [frame];
      return;
    }
    if (!last) return; // 还没见过关键帧，先不缓存
    // 16 位序号会回绕，按模判断是否正好 +1。
    const continuous = (frame.frameIndex - last.frameIndex + 65536) % 65536 === 1;
    if (!continuous) {
      this.replayBuffer = [];
      return;
    }
    this.replayBuffer.push(frame);
    // 超出上限时丢**最旧的 delta**、保留关键帧？不行 —— 关键帧之后的帧必须
    // 连续才有意义。这里改为整段作废等下一个关键帧：对端关键帧间隔实测约
    // 17 秒，缓存峰值 255 帧 × 平均 2 KB ≈ 500 KB，完全可以一直留着。
    // 上限只是防止异常码流（关键帧间隔极大）把内存吃爆。
    if (this.replayBuffer.length > REPLAY_FRAMES) this.replayBuffer = [];
  }

  /**
   * `AVSDKPlugin` 和 `wrapper.node` 同在 QQ 的 `resources/app` 下；
   * linux 的插件在它下面的 `avsdk/` 子目录，`nt_helper` 会自己找。
   */
  private resolveModulesDir(): string | null {
    const wrapper = this.platform.qqWrapperNodePath();
    if (!wrapper) return null;
    return join(wrapper, '..');
  }
}

/** 通话状态的中文描述，界面直接用。 */
export function describeCallState(state: CallState): string {
  switch (state) {
    case 'idle':
      return '空闲';
    case 'calling':
      return '正在呼叫';
    case 'ringing':
      return '对方振铃中';
    case 'connecting':
      return '正在接通';
    case 'connected':
      return '通话中';
    case 'ending':
      return '正在挂断';
    case 'ended':
      return '已结束';
    case 'failed':
      return '呼叫失败';
  }
}
