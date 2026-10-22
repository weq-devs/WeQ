import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server, IncomingMessage } from 'node:http';
import type { AnyRouter } from '@trpc/server';
import { AuthGate } from './auth';
import { startServer } from './http';
import { createWebHost } from './host';
import { createTrpcHandler, attachWsHandler } from './trpc_adapter';
import type { RemotePairing } from '../remote/pairing';
import { webCredential } from '../remote/web_gateway';

interface WebConfig {
  publicDir: string;
  exportDir: string;
  version: string;
  router: AnyRouter;
  pairing: RemotePairing;
  getAutoStart: () => boolean;
  setAutoStart: (enabled: boolean) => void;
}

export class DesktopWebRuntime {
  private config: WebConfig | null = null;
  private server: Server | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private auth: AuthGate | null = null;
  private closeWs: (() => void) | null = null;
  private revision = 0;
  private starting = false;
  private error: string | null = null;

  configure(config: WebConfig): void {
    this.config = config;
  }

  status() {
    return {
      available: this.config !== null,
      assetsInstalled: !!this.config && existsSync(join(this.config.publicDir, 'index.html')),
      enabled: this.server !== null,
      autoStart: this.config?.getAutoStart() ?? false,
      url: this.port ? `http://127.0.0.1:${this.port}` : null,
      port: this.port,
      error: this.error,
    };
  }

  setAutoStart(enabled: boolean): void {
    if (!this.config) throw new Error('仅桌面端可用。');
    this.config.setAutoStart(enabled);
  }

  accessToken(): string {
    if (!this.token) throw new Error('请先开启 Web 服务。');
    return this.token;
  }

  async start(): Promise<void> {
    if (this.server || this.starting) return;
    const config = this.config;
    if (!config || !existsSync(join(config.publicDir, 'index.html')))
      throw new Error('Web 页面尚未构建，请运行 pnpm --filter @weq/web exec vite build。');
    this.starting = true;
    this.error = null;
    const generation = this.revision;
    const token = randomBytes(32).toString('hex');
    const auth = new AuthGate({ token, remote: false });
    const sameOrigin = (req: IncomingMessage) =>
      !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
    const gate = {
      login: auth.login.bind(auth),
      logout: auth.logout.bind(auth),
      isAuthed: (req: IncomingMessage) =>
        sameOrigin(req) && (config.pairing.canAccessWeb(webCredential(req)) || auth.isAuthed(req)),
      watchSession: (req: IncomingMessage, revoke: () => void) =>
        config.pairing.canAccessWeb(webCredential(req))
          ? config.pairing.watchWeb(webCredential(req), revoke)
          : auth.watchSession(req, revoke),
    };
    try {
      const host = createWebHost({ exportDir: config.exportDir, version: config.version });
      const { server, port } = await startServer({
        port: 7690,
        host: '127.0.0.1',
        publicDir: config.publicDir,
        auth: gate,
        trpc: createTrpcHandler(config.router, gate, host),
        hostBridge: host,
      });
      if (generation !== this.revision) {
        server.close();
        server.closeAllConnections();
        auth.close();
        return;
      }
      this.closeWs = attachWsHandler(server, config.router, gate, host);
      this.server = server;
      this.port = port;
      this.token = token;
      this.auth = auth;
    } catch {
      auth.close();
      this.error = 'Web 服务启动失败，请检查端口或页面构建。';
      throw new Error(this.error);
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.revision++;
    this.closeWs?.();
    this.closeWs = null;
    this.auth?.close();
    this.auth = null;
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    this.port = null;
    this.token = null;
    this.error = null;
  }
}

export const desktopWebRuntime = new DesktopWebRuntime();
