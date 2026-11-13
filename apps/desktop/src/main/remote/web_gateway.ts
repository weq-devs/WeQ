import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { WebApplication, WebAuth } from '../web/application';
import type { RemotePairing } from './pairing';
import { observeRemoteRequest } from './device';

function webCredential(req: IncomingMessage): string {
  const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
  if (bearer) return bearer[1]!;
  return /(?:^|;\s*)weq_remote=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
}

/** Remote 独立认证并挂载共享 Web 核心，不依赖本机浏览器监听端口。 */
export class RemoteWebGateway {
  private readonly application: WebApplication;
  private readonly allowed: (req: IncomingMessage) => boolean;

  constructor(pairing: RemotePairing, createApplication: (auth: WebAuth) => WebApplication) {
    this.allowed = (req) => {
      const host = req.headers.host;
      return (
        !!host &&
        (!req.headers.origin ||
          req.headers.origin === `http://${host}` ||
          req.headers.origin === `https://${host}`) &&
        pairing.canAccessWeb(webCredential(req), observeRemoteRequest(req))
      );
    };
    this.application = createApplication({
      remoteClient: true,
      login: async () => false,
      logout: () => {},
      isAuthed: this.allowed,
      watchSession: (req, revoke) => pairing.watchWeb(webCredential(req), revoke),
    });
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    if (!this.allowed(req)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      res.end('设备未获 Web 访问授权，请重新配对。');
      return;
    }
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${req.headers.host} wss://${req.headers.host}; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    this.application.handle(req, res);
  }

  attach(server: Server): void {
    this.application.attach(server);
  }

  close(): void {
    this.application.close();
  }
}
