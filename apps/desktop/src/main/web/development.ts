import http, { type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
  parse,
  serialize,
  defaultTreeAdapter,
  html as htmlNames,
  type DefaultTreeAdapterMap,
} from 'parse5';
import type { AuthGate } from './auth';
import { developmentStartupProgress } from './development_progress';
import { acceptsGzip } from './compression';
import { lockRemoteViewport } from './remote_viewport';
import { startupResourceTracker } from './startup_assets';

/** 仅开发入口显式启用；页面、模块与 HMR 都经原宿主认证，客户端无需访问环回端口。 */
export class DevelopmentWebProxy {
  private readonly target: URL;
  private readonly requests = new Set<ClientRequest>();
  private readonly sockets = new Set<Duplex>();

  constructor(
    url: string,
    private readonly auth: Pick<AuthGate, 'isAuthed' | 'watchSession'>,
  ) {
    this.target = new URL(url);
    if (
      this.target.protocol !== 'http:' ||
      this.target.hostname !== '127.0.0.1' ||
      this.target.username ||
      this.target.password ||
      this.target.pathname !== '/' ||
      this.target.search ||
      this.target.hash
    )
      throw new Error('Web 开发服务必须使用本机环回 HTTP 地址');
  }

  private request(req: IncomingMessage): ClientRequest {
    const headers = { ...req.headers, host: this.target.host };
    delete headers.cookie;
    delete headers.authorization;
    delete headers['accept-encoding'];
    if (headers.origin) headers.origin = this.target.origin;
    const outgoing = http.request(this.target, {
      method: req.method,
      path: req.url,
      headers,
    });
    this.requests.add(outgoing);
    outgoing.once('close', () => this.requests.delete(outgoing));
    return outgoing;
  }

  readonly handle = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const outgoing = this.request(req);
      const finish = () => {
        outgoing.destroy();
        resolve();
      };
      res.once('close', finish);
      outgoing.once('error', () => {
        if (!res.headersSent) res.writeHead(502).end('Web 开发服务暂不可用');
        else res.destroy();
      });
      outgoing.once('response', (upstream) => {
        const headers = { ...upstream.headers };
        const status = upstream.statusCode ?? 502;
        const html = headers['content-type']?.includes('text/html');
        const cache = headers['cache-control'] ?? 'no-cache';
        headers['cache-control'] =
          html || status >= 400 ? 'no-store' : `private, ${cache.replace(/\bpublic,?\s*/i, '')}`;
        upstream.once('error', () => res.destroy());
        if (!html || req.method === 'HEAD') {
          const compressible =
            status === 200 &&
            !headers['content-encoding'] &&
            /^(?:text\/|application\/(?:javascript|json)|image\/svg\+xml)/i.test(
              headers['content-type'] ?? '',
            );
          if (compressible || status === 304)
            headers.vary = [headers.vary, 'Accept-Encoding'].filter(Boolean).join(', ');
          if (compressible && acceptsGzip(req.headers['accept-encoding'] ?? '')) {
            headers['content-encoding'] = 'gzip';
            delete headers['content-length'];
            if (req.method !== 'HEAD') {
              res.writeHead(status, headers);
              void pipeline(upstream, createGzip(), res).catch(() => res.destroy());
              return;
            }
          }
          res.writeHead(status, headers);
          upstream.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        upstream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            upstream.destroy();
            res.destroy();
          } else chunks.push(chunk);
        });
        upstream.once('end', () => {
          const page = developmentHtml(
            Buffer.concat(chunks).toString('utf8'),
            /\bWeQRemote\b/.test(req.headers['user-agent'] ?? ''),
          );
          headers['content-type'] = 'text/html; charset=utf-8';
          delete headers['content-length'];
          delete headers.etag;
          res.writeHead(status, headers).end(page);
        });
      });
      outgoing.end();
    });
  };

  readonly upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if ((req.url ?? '').split('?')[0] !== '/_weq-dev/hmr') return false;
    if (!this.auth.isAuthed(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return true;
    }
    const outgoing = this.request(req);
    this.sockets.add(socket);
    const unwatch = this.auth.watchSession(req, () => socket.destroy());
    socket.once('close', () => {
      unwatch();
      this.sockets.delete(socket);
      outgoing.destroy();
    });
    socket.once('error', () => socket.destroy());
    outgoing.once('error', () => socket.destroy());
    outgoing.once('response', (response) => {
      response.resume();
      socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`);
    });
    outgoing.once('upgrade', (response, upstream, upstreamHead) => {
      this.sockets.add(upstream);
      upstream.once('error', () => socket.destroy());
      upstream.once('close', () => {
        this.sockets.delete(upstream);
        socket.destroy();
      });
      socket.once('close', () => upstream.destroy());
      if (socket.destroyed) {
        upstream.destroy();
        return;
      }
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce(
          (text, value, index, values) =>
            index % 2 ? text : `${text}${value}: ${values[index + 1]}\r\n`,
          '',
        )}\r\n`,
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    outgoing.end();
    return true;
  };

  close(): void {
    for (const request of this.requests) request.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.requests.clear();
    this.sockets.clear();
  }
}

/** React Refresh 的内联引导只在开发 HTML 放行，正式页的 CSP 保持原样。 */
function developmentHtml(html: string, remote: boolean): string {
  const document = parse(html);
  let head: DefaultTreeAdapterMap['element'] | undefined;
  let startupManifest: DefaultTreeAdapterMap['element'] | undefined;
  const visit = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node && node.tagName === 'head') head = node;
    if (
      'tagName' in node &&
      node.tagName === 'meta' &&
      node.attrs.some(
        (attr) => attr.name === 'name' && attr.value === 'weq-development-startup-resources',
      )
    ) {
      startupManifest = node;
    }
    if (
      'tagName' in node &&
      node.tagName === 'meta' &&
      node.attrs.some(
        (attr) =>
          attr.name === 'http-equiv' && attr.value.toLowerCase() === 'content-security-policy',
      )
    ) {
      const content = node.attrs.find((attr) => attr.name === 'content');
      if (content)
        content.value = content.value
          .split(';')
          .map((directive) => {
            const parts = directive.trim().split(/\s+/);
            if (
              (parts[0] === 'script-src' || parts[0] === 'script-src-elem') &&
              !parts.includes("'unsafe-inline'")
            )
              parts.push("'unsafe-inline'");
            return parts.join(' ');
          })
          .join('; ');
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(document);
  if (startupManifest) {
    if (remote)
      startupManifest.attrs.find((attr) => attr.name === 'name')!.value = 'weq-startup-resources';
    else defaultTreeAdapter.detachNode(startupManifest);
  }
  if (remote && head) {
    lockRemoteViewport(head);
    const progress = defaultTreeAdapter.createElement('script', htmlNames.NS.HTML, [
      { name: 'data-weq-development-progress', value: '' },
    ]);
    defaultTreeAdapter.insertText(
      progress,
      (startupManifest ? startupResourceTracker : '') + developmentStartupProgress,
    );
    const first = head.childNodes.find(
      (node) => 'tagName' in node && (node.tagName === 'script' || node.tagName === 'link'),
    );
    if (first) defaultTreeAdapter.insertBefore(head, progress, first);
    else defaultTreeAdapter.appendChild(head, progress);
  }
  return serialize(document);
}
