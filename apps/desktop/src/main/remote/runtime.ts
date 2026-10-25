import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Server } from 'node:http';
import { z } from 'zod';
import QRCode from 'qrcode';
import { RemotePairing } from './pairing';
import { createRemoteServer } from './http';
import {
  remoteInviteInput,
  remoteDirectAddresses,
  type RemoteConnectionMode,
} from '../../shared/remote_bootstrap';
import { RemoteStore } from './store';
import { join } from 'node:path';

const networkEvent = z.object({
  state: z.enum(['starting', 'login', 'online', 'offline', 'error']),
  authUrl: z.string().url().optional(),
  address: z.string().optional(),
  error: z.string().optional(),
  addresses: z.array(z.string().url()).optional(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export class RemoteRuntime {
  constructor(private readonly launch: typeof spawn = spawn) {}
  readonly pairing = new RemotePairing();
  private config: {
    helper: string;
    stateDir: string;
    webPort?: () => number | null;
    lanPort?: number;
  } | null = null;
  private server: Server | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: z.infer<typeof networkEvent> = { state: 'offline' };
  private starting = false;
  private store: RemoteStore | null = null;
  private mode: RemoteConnectionMode = 'lan';
  private closing: Promise<void> = Promise.resolve();
  private tailscaleChild: ChildProcessWithoutNullStreams | null = null;
  private tailscaleState: z.infer<typeof networkEvent> = { state: 'offline' };
  private tailscaleClosing: Promise<void> = Promise.resolve();

  configure(config: {
    helper: string;
    stateDir: string;
    webPort?: () => number | null;
    onRequest?: () => void;
    lanPort?: number;
  }): void {
    this.config = config;
    this.pairing.onRequest = config.onRequest;
    try {
      this.store = new RemoteStore(config.stateDir);
      this.mode = this.store.read().mode;
      this.pairing.restore(this.store.claims(), (claims) => this.store?.save({ claims }));
    } catch {
      this.config = null;
      this.store = null;
      this.state = {
        state: 'error',
        error: '无法读取已保存的设备授权，请检查远程连接配置文件；原文件未被覆盖。',
      };
    }
  }

  async resume(): Promise<void> {
    if (this.store?.read().enabled) await this.start();
  }

  async setMode(mode: RemoteConnectionMode): Promise<void> {
    this.mode = mode;
    this.store?.save({ mode });
    await this.setTailscaleEnabled(mode !== 'lan');
  }

  async setTailscaleEnabled(enabled: boolean): Promise<void> {
    this.store?.save({ tailscaleEnabled: enabled });
    if (!enabled) this.stopTailscale();
    else if (this.server) await this.startTailscale();
  }

  private stopTailscale(): void {
    const child = this.tailscaleChild;
    this.tailscaleChild = null;
    this.tailscaleState = { state: 'offline' };
    this.pairing.cancelInvitation();
    if (!child) return;
    if (child.exitCode === null) {
      this.tailscaleClosing = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    child.stdin.end();
    child.kill();
  }

  private async startTailscale(): Promise<void> {
    await this.tailscaleClosing;
    if (
      this.tailscaleChild ||
      !this.server ||
      !this.config ||
      !this.state.fingerprint ||
      !this.store?.read().tailscaleEnabled
    )
      return;
    const bound = this.server.address();
    if (!bound || typeof bound === 'string') return;
    this.tailscaleState = { state: 'starting' };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch(
        this.config.helper,
        [
          '--backend',
          `http://127.0.0.1:${bound.port}`,
          '--state',
          this.store.read().networkIdentity
            ? join(this.config.stateDir, this.store.read().networkIdentity!)
            : this.config.stateDir,
          '--lan-state',
          this.config.stateDir,
          '--mode',
          'tailscale',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch {
      this.tailscaleState = { state: 'error', error: 'WeQ 专用 Tailscale 服务启动失败。' };
      return;
    }
    this.tailscaleChild = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.tailscaleChild !== child || line.length > 8192) return;
      try {
        const event = networkEvent.parse(JSON.parse(line));
        if (event.authUrl && new URL(event.authUrl).protocol !== 'https:') return;
        if (
          event.state === 'online' &&
          (!/^http:\/\/100\.(?:\d{1,3}\.){2}\d{1,3}:7691$/.test(event.address ?? '') ||
            remoteDirectAddresses([(event.address ?? '').replace('http:', 'https:')], 'existing')
              .length !== 1)
        )
          return;
        this.tailscaleState = event;
      } catch {
        /* 只接受专用辅助进程的结构化状态。 */
      }
    });
    const failed = () => {
      lines.close();
      if (this.tailscaleChild !== child) return;
      this.stopTailscale();
      this.tailscaleState = {
        state: 'error',
        error: 'WeQ 专用 Tailscale 服务已停止，可重新启动。',
      };
    };
    child.once('error', failed);
    child.once('exit', failed);
  }

  async refreshNetwork(): Promise<void> {
    if (!this.server) return;
    this.stop();
    await this.start();
  }

  async changeNetwork(): Promise<void> {
    this.stopTailscale();
    // 更换身份而不删除原节点；旧节点可在 Tailscale 管理台移除。
    this.store?.save({
      tailscaleEnabled: true,
      networkIdentity: `network-${Date.now()}`,
    });
    await this.startTailscale();
  }

  status() {
    const tailscaleEnabled = this.store?.read().tailscaleEnabled ?? false;
    const network =
      this.server && tailscaleEnabled && this.state.fingerprint ? this.tailscaleState : this.state;
    const addresses = remoteDirectAddresses(this.state.addresses ?? [], 'lan');
    if (this.tailscaleState.state === 'online' && this.tailscaleState.address) {
      const ip = new URL(this.tailscaleState.address).hostname;
      addresses.push(`https://${ip}:7692`);
    }
    return {
      available: this.config !== null,
      helperInstalled: !!this.config && existsSync(this.config.helper),
      enabled: this.server !== null,
      mode: this.mode,
      tailscaleEnabled,
      network: { ...network, addresses, fingerprint: this.state.fingerprint },
      ...this.pairing.snapshot(),
    };
  }

  async start(): Promise<void> {
    if (this.starting || this.server) return;
    if (!this.config || !existsSync(this.config.helper)) {
      throw new Error('尚未安装 WeQ Remote 网络辅助程序，请按原型文档构建。');
    }
    this.starting = true;
    await this.closing;
    const server = createRemoteServer(this.pairing, this.config.webPort);
    this.server = server;
    this.state = { state: 'starting' };
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      if (this.server !== server) return;
      const bound = server.address();
      if (!bound || typeof bound === 'string') throw new Error('无法分配本地端口。');
      const child = this.launch(
        this.config.helper,
        [
          '--backend',
          `http://127.0.0.1:${bound.port}`,
          '--state',
          this.store?.read().networkIdentity
            ? join(this.config.stateDir, this.store.read().networkIdentity!)
            : this.config.stateDir,
          '--mode',
          'lan',
          '--lan-state',
          this.config.stateDir,
          ...(this.config.lanPort === undefined ? [] : ['--lan-port', String(this.config.lanPort)]),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      this.child = child;
      // 不将含授权链接或网络身份的辅助进程输出写进应用日志。
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        if (this.child !== child || line.length > 8192) return;
        try {
          const event = networkEvent.parse(JSON.parse(line));
          if (event.authUrl && new URL(event.authUrl).protocol !== 'https:') return;
          if (
            event.state === 'online' &&
            (!event.fingerprint ||
              !event.addresses?.every((value) =>
                /^https:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d+$/.test(value),
              ))
          )
            return;
          this.state = event;
          if (event.state === 'online' && this.store?.read().tailscaleEnabled)
            void this.startTailscale();
        } catch {
          /* 只接受辅助程序的结构化事件。 */
        }
      });
      child.once('error', () => {
        if (this.child !== child) return;
        this.stop();
        this.state = { state: 'error', error: '网络辅助程序启动失败。' };
      });
      child.once('exit', () => {
        lines.close();
        if (this.child !== child) return;
        this.stop();
        this.state = { state: 'error', error: '网络辅助程序已退出。' };
      });
      this.store?.save({ enabled: true });
      if (this.store?.read().tailscaleEnabled) await this.startTailscale();
    } catch (error) {
      this.stop();
      this.state = { state: 'error', error: '远程服务启动失败。' };
      throw error;
    } finally {
      this.starting = false;
    }
  }

  stop(disable = false): void {
    this.stopTailscale();
    if (disable) this.store?.save({ enabled: false });
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null)
      this.closing = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    child?.stdin.end();
    child?.kill();
    const server = this.server;
    this.server = null;
    server?.close();
    server?.closeAllConnections();
    this.pairing.clear();
    this.state = { state: 'offline' };
  }

  async invite(input?: z.infer<typeof remoteInviteInput>) {
    const bootstrap = remoteInviteInput.parse(input);
    const direct = !bootstrap || !('authKey' in bootstrap);
    const state = this.status().network;
    if ((!direct && this.tailscaleState.state !== 'online') || !state.fingerprint)
      throw new Error(direct ? '请先完成网络登录。' : '请先启动并登录 WeQ 专用 Tailscale 服务。');
    const selected = bootstrap && 'endpoint' in bootstrap ? bootstrap.endpoint : undefined;
    const addresses = state.addresses ?? [];
    if (selected && !addresses.includes(selected)) throw new Error('所选网络地址已不可用。');
    const endpoint = direct ? (selected ?? addresses[0]) : this.tailscaleState.address;
    if (!endpoint)
      throw new Error('没有可用的连接地址，请检查网络或启动 WeQ 专用 Tailscale 服务。');
    const invite = this.pairing.invite();
    const url = new URL('weq-remote://pair');
    url.searchParams.set('v', selected ? '3' : '4');
    if (selected) url.searchParams.set('endpoint', selected);
    else {
      const lan = remoteDirectAddresses(addresses, 'lan').slice(0, 6);
      const own = this.tailscaleState.state === 'online' ? this.tailscaleState.address : undefined;
      const tls = remoteDirectAddresses(addresses, 'existing');
      const endpoints = [...new Set([...lan, ...(own ? [own] : []), ...tls])].slice(0, 8);
      for (const address of endpoints) url.searchParams.append('endpoint', address);
    }
    url.searchParams.set('invitation', invite.secret);
    url.searchParams.set('fingerprint', state.fingerprint!);
    if (bootstrap && 'authKey' in bootstrap) {
      url.searchParams.set('authKey', bootstrap.authKey);
      url.searchParams.set('expiresAt', String(invite.expiresAt));
    }
    return {
      expiresAt: invite.expiresAt,
      pairingURL: url.toString(),
      qr: await QRCode.toDataURL(url.toString(), {
        width: 240,
        margin: 4,
        errorCorrectionLevel: 'M',
      }),
    };
  }
}

export const remoteRuntime = new RemoteRuntime();
