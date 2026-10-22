import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Server } from 'node:http';
import { z } from 'zod';
import QRCode from 'qrcode';
import { RemotePairing } from './pairing';
import { createRemoteServer } from './http';

const networkEvent = z.object({
  state: z.enum(['starting', 'login', 'online', 'offline', 'error']),
  authUrl: z.string().url().optional(),
  address: z.string().optional(),
  error: z.string().optional(),
});

export class RemoteRuntime {
  constructor(private readonly launch: typeof spawn = spawn) {}
  readonly pairing = new RemotePairing();
  private config: { helper: string; stateDir: string } | null = null;
  private server: Server | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: z.infer<typeof networkEvent> = { state: 'offline' };
  private starting = false;

  configure(config: { helper: string; stateDir: string }): void {
    this.config = config;
  }

  status() {
    return {
      available: this.config !== null,
      helperInstalled: !!this.config && existsSync(this.config.helper),
      enabled: this.server !== null,
      network: { ...this.state },
      ...this.pairing.snapshot(),
    };
  }

  async start(): Promise<void> {
    if (this.starting || this.server) return;
    if (!this.config || !existsSync(this.config.helper)) {
      throw new Error('尚未安装 WeQ Remote 网络辅助程序，请按原型文档构建。');
    }
    this.starting = true;
    const server = createRemoteServer(this.pairing);
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
        ['--backend', `http://127.0.0.1:${bound.port}`, '--state', this.config.stateDir],
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
            !/^http:\/\/100\.(?:\d{1,3}\.){2}\d{1,3}:\d+$/.test(event.address ?? '')
          )
            return;
          if (event.state !== 'online') this.pairing.clear();
          this.state = event;
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
    } catch (error) {
      this.stop();
      this.state = { state: 'error', error: '远程服务启动失败。' };
      throw error;
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    child?.stdin.end();
    child?.kill();
    const server = this.server;
    this.server = null;
    server?.close();
    server?.closeAllConnections();
    this.pairing.clear();
    this.state = { state: 'offline' };
  }

  async invite() {
    if (this.state.state !== 'online' || !this.state.address) throw new Error('请先完成网络登录。');
    const invite = this.pairing.invite();
    const url = new URL('weq-remote://pair');
    url.searchParams.set('v', '1');
    url.searchParams.set('endpoint', this.state.address);
    url.searchParams.set('invitation', invite.secret);
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
