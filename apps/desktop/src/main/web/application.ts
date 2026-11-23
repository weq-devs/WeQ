import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnyRouter } from '@trpc/server';
import { withHost, type HostBridge } from '@weq/service';
import type { AuthGate } from './auth';
import { handleRequest, type RequestOptions } from './http';
import { createWebHost } from './host';
import { attachWsHandler, createTrpcHandler } from './trpc_adapter';
import { DevelopmentWebProxy } from './development';
import type { ResolveGroupVideo } from './group_video';
import { preparedStartupDocument } from './startup_assets';

export type WebAuth = Pick<AuthGate, 'login' | 'logout' | 'isAuthed' | 'watchSession'> & {
  remoteClient?: boolean;
};

export interface WebCoreConfig {
  publicDir: string;
  exportDir: string;
  version: string;
  router: AnyRouter;
  groupVideoSession?: ResolveGroupVideo;
  developmentUrl?: string;
  renderer?: Pick<HostBridge, 'renderHtmlToPdf' | 'renderHtmlToSlidesPng' | 'renderHtmlToLongPng'>;
}

/** 共用业务路由和宿主；各入口只持有自己的认证、请求与订阅。 */
export class WebCore {
  private readonly host: HostBridge;

  constructor(private readonly config: WebCoreConfig) {
    this.host = createWebHost(config);
  }

  get assetsInstalled(): boolean {
    return !!this.config.developmentUrl || existsSync(join(this.config.publicDir, 'index.html'));
  }

  entry(auth: WebAuth): WebApplication {
    if (!this.assetsInstalled)
      throw new Error('Web 页面尚未构建，请运行 pnpm --filter @weq/web exec vite build。');
    const host = auth.remoteClient ? { ...this.host, remoteClient: true } : this.host;
    return new WebApplication(this.config, host, auth);
  }
}

export class WebApplication {
  private closeWs: (() => void) | null = null;
  private readonly responses = new Set<ServerResponse>();
  private closed = false;
  private readonly options: RequestOptions;
  private readonly development?: DevelopmentWebProxy;
  private release?: Promise<string | undefined>;

  constructor(
    private readonly config: WebCoreConfig,
    private readonly host: HostBridge,
    private readonly auth: WebAuth,
  ) {
    if (config.developmentUrl)
      this.development = new DevelopmentWebProxy(config.developmentUrl, auth);
    this.options = {
      publicDir: config.publicDir,
      auth,
      trpc: createTrpcHandler(config.router, auth, host),
      hostBridge: host,
      development: this.development?.handle,
    };
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    if (this.closed) {
      res.writeHead(503).end('Web 入口已关闭。');
      return;
    }
    this.responses.add(res);
    const unwatch = this.auth.isAuthed(req)
      ? this.auth.watchSession(req, () => res.destroy())
      : () => {};
    res.once('close', () => {
      unwatch();
      this.responses.delete(res);
    });
    void withHost(this.host, () => handleRequest(req, res, this.options)).catch((error) => {
      console.error('[web] request failed:', error);
      if (!res.headersSent) res.writeHead(500).end('internal error');
      else res.destroy();
    });
  }

  stableWebRelease(): Promise<string | undefined> | undefined {
    if (this.development) return;
    this.release ??= readFile(join(this.config.publicDir, 'index.html'), 'utf8')
      .then((html) => preparedStartupDocument(this.config.publicDir, html, false))
      .then(({ completeOffline, version }) => (completeOffline ? version : undefined))
      .catch(() => {
        this.release = undefined;
        return undefined;
      });
    return this.release;
  }

  attach(server: Server): void {
    this.closeWs = attachWsHandler(
      server,
      this.config.router,
      this.auth,
      this.host,
      this.development?.upgrade,
      this.config.groupVideoSession,
    );
  }

  close(): void {
    this.closed = true;
    this.closeWs?.();
    this.closeWs = null;
    this.development?.close();
    for (const response of this.responses) response.destroy();
    this.responses.clear();
  }
}
