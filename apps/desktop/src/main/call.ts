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
} from '@weq/service';
import { CallRecorder, type RecordingSnapshot } from './call_recorder';
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

const logger = getLogger().child({ scope: 'call' });

// ─────────────────────────── UDP ───────────────────────────

/** `node:dgram` 的 udp4 套接字适配成 `CallSession` 要的形状。 */
class NodeUdpTransport implements UdpTransport {
  private socket: dgram.Socket | null = null;

  async bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.removeListener('error', reject);
        this.socket = socket;
        resolve();
      });
    });
  }

  send(data: Uint8Array, port: number, address: string): void {
    if (!this.socket) return;
    // 直接拷一份：dgram 的回调可能在原缓冲被复写之后才跑。
    const buffer = Buffer.from(data);
    this.socket.send(buffer, 0, buffer.length, port, address, () => {});
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // 已关闭 / 未绑定，忽略。
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
    if (this.socket) register(this.socket);
    else this.pending.push(register);
  }

  /** 绑定完成后把排队的监听器挂上。 */
  attach(): void {
    if (!this.socket) return;
    for (const register of this.pending) register(this.socket);
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
}

export type CallEvent =
  | { type: 'state'; call: ActiveCallInfo }
  | { type: 'audio'; pcm: Uint8Array }
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

  /** 发起一路通话。已有通话在跑时直接报错，由界面提示先挂断。 */
  async start(params: StartCallParams): Promise<ActiveCallInfo> {
    if (this.session) throw new Error('当前已有通话，请先挂断');

    const modulesDir = this.resolveModulesDir();
    if (!modulesDir) throw new Error('找不到 QQ 的 AVSDK 目录，无法初始化语音编解码器');

    const transport = new NodeUdpTransport();
    const codec = new NativeCallCodec(this.nt, modulesDir);
    const session = new CallSession({
      selfUin: params.selfUin,
      selfUid: params.selfUid,
      peerUin: params.peerUin,
      peerUid: params.peerUid,
      signaling: protocolSignaling(this.nt, params.pid),
      transport: {
        bind: async () => {
          await transport.bind();
          transport.attach();
        },
        send: (data, port, address) => transport.send(data, port, address),
        close: () => transport.close(),
        onMessage: (handler) => transport.onMessage(handler),
        onError: (handler) => transport.onError(handler),
      },
      codec,
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
    this.session = null;
    this.transport = null;
    this.info = null;
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
