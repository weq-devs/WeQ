import {
  request,
  type IncomingMessage,
  type ServerResponse,
  type Server,
  type OutgoingHttpHeaders,
} from 'node:http';
import type { Duplex } from 'node:stream';
import type { RemotePairing } from './pairing';

export function webCredential(req: IncomingMessage): string {
  const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
  if (bearer) return bearer[1]!;
  return /(?:^|;\s*)weq_remote=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
}

/** 只转发到桌面端实际持有的 Web 服务端口，不探测或接管其他服务。 */
export class RemoteWebGateway {
  constructor(
    private readonly pairing: RemotePairing,
    private readonly getPort: () => number | null,
  ) {}

  private allowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return (
      !!host &&
      (!req.headers.origin ||
        req.headers.origin === `http://${host}` ||
        req.headers.origin === `https://${host}`) &&
      this.pairing.canAccessWeb(webCredential(req))
    );
  }

  private headers(req: IncomingMessage, port: number) {
    const headers: OutgoingHttpHeaders = {
      ...req.headers,
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${webCredential(req)}`,
    };
    delete headers['proxy-authorization'];
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    delete headers.forwarded;
    headers.cookie = (req.headers.cookie ?? '')
      .split(';')
      .filter((part) => !part.trim().startsWith('weq_remote='))
      .join(';');
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
    return headers;
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    if (!this.allowed(req)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      res.end('设备未获 Web 访问授权，请重新配对。');
      return;
    }
    const port = this.getPort();
    if (!port) {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('Web 服务已关闭，请在电脑设置中开启。');
      return;
    }
    const upstream = request({
      hostname: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: this.headers(req, port),
    });
    const unwatch = this.pairing.watchWeb(webCredential(req), () => {
      upstream.destroy();
      res.destroy();
    });
    res.once('close', () => {
      unwatch();
      upstream.destroy();
    });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on('response', (response) => {
      response.headers['content-security-policy'] =
        `default-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${req.headers.host} wss://${req.headers.host}; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
      response.headers['referrer-policy'] = 'no-referrer';
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('Web 服务暂不可用，请检查电脑设置。');
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if ((req.url ?? '').split('?')[0] !== '/trpc-ws' || !this.allowed(req)) {
      socket.destroy();
      return;
    }
    const port = this.getPort();
    if (!port) {
      socket.destroy();
      return;
    }
    const upstream = request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: req.url,
      headers: this.headers(req, port),
    });
    let remote: Duplex | undefined;
    const unwatch = this.pairing.watchWeb(webCredential(req), () => {
      upstream.destroy();
      remote?.destroy();
      socket.destroy();
    });
    socket.once('close', () => {
      unwatch();
      upstream.destroy();
      remote?.destroy();
    });
    socket.on('error', () => {
      upstream.destroy();
      remote?.destroy();
    });
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.on('upgrade', (response, stream, responseHead) => {
      remote = stream;
      upstream.setTimeout(0);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\r\n')}\r\n\r\n`,
      );
      if (responseHead.length) socket.write(responseHead);
      if (head.length) stream.write(head);
      stream.on('error', () => socket.destroy());
      stream.once('close', () => socket.destroy());
      socket.pipe(stream).pipe(socket);
    });
    upstream.on('response', (response) => {
      response.resume();
      socket.destroy();
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }
}
