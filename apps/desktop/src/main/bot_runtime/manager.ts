/**
 * WeqBot daemon 的进程管理。
 *
 * 一个账号一个 daemon 进程（`weqbot-daemon --serve --account <uin>`），通过 unix
 * socket / named pipe 上的控制通道交互。**不使用 sidecar（stdio）形态**：daemon
 * 的设计目标是「宿主退出后 bot 继续在线」，而 sidecar 会随 stdin 关闭退出。
 *
 * 三条生命周期规则（2026-11-19 用户拍板）：
 *
 *   1. 账号打开 → `ensure()` + `onebot.set` 下发该账号的网络配置；
 *   2. 账号关闭 / 切号 → `shutdown()`，daemon 发 `UnRegister` 后退出；
 *   3. **WeQ 退出（关窗口 / 关进程）→ 只断开 socket，不发 `shutdown`** ——
 *      bot 继续在线，下次启动时重连。
 *
 * 残留 socket（上次崩溃）：`connectControlSocket` 连不上、但文件在 → 先探活，
 * 连不上才认为是尸体并清理。不盲删：两个 daemon 挂到同一个 uin 上比崩溃更难查。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { getLogger } from '@weq/service';
import {
  connectControlSocket,
  type ControlEnvelope,
  type ControlOneBotConfig,
  type ControlOneBotState,
  type ControlObservedMessage,
  type ControlPeer,
  type ControlStatus,
} from '@weqbot/control';
import { resolveDaemonPaths, type DaemonPaths } from './paths';

const logger = getLogger().child({ scope: 'bot-runtime' });

/** 一条 daemon 的连接。 */
interface DaemonHandle {
  uin: string;
  paths: DaemonPaths;
  peer: ControlPeer;
  child: ChildProcess | null;
  /** 最近一次 `status` 的结果（事件驱动的缓存）。 */
  status: ControlStatus | null;
}

export type OneBotEventListener = (uin: string, event: ControlEnvelope) => void;

export interface BotRuntimeOptions {
  /** 覆盖入口 / socket / native 目录（测试）。 */
  resolvePaths?: typeof resolveDaemonPaths;
  /** daemon 启动后多久内必须能 `ping` 通（默认 20s：要加载 native + 等 socket）。 */
  connectTimeoutMs?: number;
  /** 事件订阅（宿主把它转成 IPC）。 */
  onEvent?: OneBotEventListener;
}

export interface OpenAttachParams {
  pid: number;
  uid: string;
  guid: string;
  a2: string;
  d2: string;
  d2Key: string;
  secToken?: string;
  subAppId: number;
  clientVersion?: string;
  qua?: string | null;
  wrapperPath?: string;
}

export class BotRuntime {
  private readonly daemons = new Map<string, DaemonHandle>();
  private readonly starting = new Map<string, Promise<DaemonHandle>>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly listeners = new Set<OneBotEventListener>();
  private readonly resolvePaths: typeof resolveDaemonPaths;
  private readonly connectTimeoutMs: number;

  constructor(options: BotRuntimeOptions = {}) {
    this.resolvePaths = options.resolvePaths ?? resolveDaemonPaths;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  /** 当前连着的 daemon 数（诊断 / 关机时用）。 */
  get size(): number {
    return this.daemons.size;
  }

  onEvent(listener: OneBotEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 确保该账号的 daemon 在跑并已连上。
   *
   * 已经连上就复用；socket 上有一个活着的 daemon（WeQ 重启过）也直接接管，
   * 不重新 spawn —— 那会把正在线的 bot 踢掉。
   */
  async ensure(uin: string): Promise<DaemonHandle> {
    const stopping = this.stopping.get(uin);
    if (stopping) await stopping;
    const existing = this.daemons.get(uin);
    if (existing && !existing.peer.closed) return existing;
    if (existing) this.daemons.delete(uin);
    const pending = this.starting.get(uin);
    if (pending) return pending;

    const start = this.connect(uin);
    this.starting.set(uin, start);
    try {
      return await start;
    } finally {
      this.starting.delete(uin);
    }
  }

  private async connect(uin: string): Promise<DaemonHandle> {
    const paths = this.resolvePaths({ uin });

    // 先试连接：WeQ 重启后 socket 上可能还挂着一个活着的 daemon。
    const adopted = await this.tryConnect(paths);
    if (adopted) {
      logger.info('接管已在运行的 daemon', { uin, socket: paths.socketPath });
      return this.track(uin, paths, adopted, null);
    }

    // 连不上但 socket 文件还在 = 上次崩溃的尸体。删掉再 spawn。
    await this.removeStaleSocket(paths.socketPath, uin);
    const child = this.spawnDaemon(paths, uin);
    const peer = await this.connectWithRetry(paths);
    return this.track(uin, paths, peer, child);
  }

  /** 用 a1 走 mode 2（QQ 必须离线）。 */
  async login(
    uin: string,
    params: { a1: string; guid: string; uid?: string; qqDbPath?: string },
  ): Promise<ControlStatus> {
    const handle = await this.ensure(uin);
    return handle.peer.request('login', params);
  }

  /** 有头模式借运行中 QQ 的会话，不申请 QQ 服务端推送。 */
  async attach(uin: string, params: OpenAttachParams): Promise<ControlStatus> {
    const handle = await this.ensure(uin);
    return handle.peer.request('attach', { ...params, uin });
  }

  async getOneBot(uin: string): Promise<ControlOneBotState> {
    const handle = await this.ensure(uin);
    return handle.peer.request('onebot.get', {});
  }

  async setOneBot(uin: string, config: ControlOneBotConfig | null): Promise<ControlOneBotState> {
    const handle = await this.ensure(uin);
    return handle.peer.request('onebot.set', { config });
  }

  async status(uin: string): Promise<ControlStatus> {
    const handle = await this.ensure(uin);
    return handle.peer.request('status', {});
  }

  async observeMessage(uin: string, sessionId: number, message: ControlObservedMessage) {
    const handle = this.daemons.get(uin);
    if (!handle) return false;
    return (await handle.peer.request('onebot.observeMessage', { sessionId, message })).accepted;
  }

  /**
   * 关账号：让 daemon 优雅下线（发 `UnRegister`）并退出。
   *
   * 与 {@link disconnectAll} 的区别是**它会杀掉 bot**；那个只是断开 WeQ 这边的
   * 连接，bot 继续在线。
   */
  async shutdown(uin: string, reason?: string): Promise<void> {
    const pending = this.stopping.get(uin);
    if (pending) return pending;
    const stopping = this.stop(uin, reason);
    this.stopping.set(uin, stopping);
    try {
      await stopping;
    } finally {
      this.stopping.delete(uin);
    }
  }

  private async stop(uin: string, reason?: string): Promise<void> {
    const handle = this.daemons.get(uin) ?? (await this.starting.get(uin)?.catch(() => undefined));
    this.daemons.delete(uin);
    if (!handle) return;
    try {
      await handle.peer.request('shutdown', reason ? { reason } : {}, { timeoutMs: 10_000 });
      // ack 先到，退出时才关闭监听。不能在这期间把旧进程接管为新会话。
      const deadline = Date.now() + 10_000;
      while (
        !handle.peer.closed ||
        (process.platform !== 'win32' && existsSync(handle.paths.socketPath))
      ) {
        if (Date.now() >= deadline) throw new Error('等待 OneBot daemon 退出超时');
        await delay(25);
      }
    } catch (cause) {
      logger.warn('daemon shutdown 请求失败，直接断开', { uin, cause });
    } finally {
      handle.peer.close();
    }
  }

  /**
   * WeQ 退出：只断开连接，**不杀 daemon**。
   *
   * 这是 `--serve` 形态的存在理由：用户关掉界面不代表想让 bot 下线。
   */
  disconnectAll(): void {
    for (const handle of this.daemons.values()) handle.peer.close();
    this.daemons.clear();
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private track(
    uin: string,
    paths: DaemonPaths,
    peer: ControlPeer,
    child: ChildProcess | null,
  ): DaemonHandle {
    const handle: DaemonHandle = { uin, paths, peer, child, status: null };
    this.daemons.set(uin, handle);
    peer.on((envelope) => {
      if (envelope.kind !== 'event') return;
      for (const listener of this.listeners) listener(uin, envelope);
    });
    child?.once('exit', (code, signal) => {
      logger.warn('daemon 进程退出', { uin, code, signal });
      // 不是我们主动 shutdown 的：把连接从表里摘掉，下次 ensure 会重连 / 重拉。
      if (this.daemons.get(uin)?.child === child) this.daemons.delete(uin);
    });
    return handle;
  }

  private spawnDaemon(paths: DaemonPaths, uin: string): ChildProcess {
    logger.info('拉起 weqbot daemon', {
      uin,
      entry: paths.entry,
      socket: paths.socketPath,
      nativeDir: paths.nativeDir,
    });
    const child = spawn(
      paths.node,
      [...paths.nodeArgs, paths.entry, '--serve', '--account', uin, '--socket', paths.socketPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          WEQBOT_NATIVE_DIR: paths.nativeDir,
          // Electron 里 `process.execPath` 是 GUI 程序；daemon 要当 Node 跑。
          // 打包后入口是 .mjs，这一项只对 dev 的 tsx 路径无效但无害。
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug('daemon stdout', { uin, text: chunk.toString().trimEnd() });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) logger.info('daemon', { uin, text });
    });
    child.once('error', (cause) => {
      logger.error('daemon 启动失败', { uin, cause });
    });
    return child;
  }

  private async tryConnect(paths: DaemonPaths): Promise<ControlPeer | null> {
    if (!existsSync(paths.socketPath)) return null;
    try {
      const peer = await connectControlSocket({
        path: paths.socketPath,
        connectTimeoutMs: 2_000,
      });
      // 连得上还要确认对端确实是活的（socket 可能是崩溃时留下的半开连接）。
      await peer.request('ping', {}, { timeoutMs: 3_000 });
      return peer;
    } catch {
      return null;
    }
  }

  private async removeStaleSocket(socketPath: string, uin: string): Promise<void> {
    if (!existsSync(socketPath)) return;
    logger.warn('清理残留的控制通道 socket（上次异常退出）', { uin, socket: socketPath });
    await rm(socketPath, { force: true });
  }

  /** spawn 之后等 socket 出现并 ping 通。 */
  private async connectWithRetry(paths: DaemonPaths): Promise<ControlPeer> {
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const peer = await connectControlSocket({
          path: paths.socketPath,
          connectTimeoutMs: 1_000,
        });
        await peer.request('ping', {}, { timeoutMs: 2_000 });
        return peer;
      } catch (cause) {
        lastError = cause;
        await delay(150);
      }
    }
    throw new Error(
      `weqbot daemon 未在 ${this.connectTimeoutMs}ms 内就绪（socket ${paths.socketPath}）：` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
