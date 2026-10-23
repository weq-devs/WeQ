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
  type CallSnapshot,
  type CallState,
  type UdpTransport,
} from '@weq/service';

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
}

export interface StartCallParams {
  pid: number;
  selfUin: string;
  selfUid: string;
  peerUin: string;
  peerUid: string;
  peerName?: string;
  peerAvatar?: string;
  /** 通话背景（由调用方先用 `ensureCallBackground` 取得；拿不到就留空）。 */
  backgroundUrl?: string;
  backgroundVideoUrl?: string;
}

export type CallEvent =
  | { type: 'state'; call: ActiveCallInfo }
  | { type: 'audio'; pcm: Uint8Array }
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
    this.info = {
      ...session.snapshot(),
      peerName: params.peerName ?? '',
      peerAvatar: params.peerAvatar ?? '',
      backgroundUrl: params.backgroundUrl ?? '',
      backgroundVideoUrl: params.backgroundVideoUrl ?? '',
      durationSec: 0,
    };

    session.onStateChange((snapshot) => {
      if (snapshot.state === 'connected') this.startDurationTicker();
      this.publishState(snapshot);
    });
    session.onAudio((pcm) => {
      this.emit('event', { type: 'audio', pcm } satisfies CallEvent);
    });

    await session.start();
    this.publishState(session.snapshot());
    return this.info!;
  }

  /** 主动挂断。 */
  async hangup(): Promise<void> {
    const session = this.session;
    if (!session) return;
    await session.hangup();
    this.cleanup();
  }

  /** 界面推来一帧麦克风音频。 */
  pushAudio(pcm: Uint8Array): void {
    this.session?.pushAudio(pcm);
  }

  /** 进程退出 / 账号切换时强制收尾。 */
  dispose(): void {
    const session = this.session;
    if (!session) return;
    void session.hangup().finally(() => this.cleanup());
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
