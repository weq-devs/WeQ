import http, { type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gzipSync } from 'node:zlib';
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
import { allowRemoteMedia } from './remote_media_policy';
import { lockRemoteViewport } from './remote_viewport';
import { remoteReleaseDocument, startupResourceTracker } from './startup_assets';
import { matchesIfNoneMatch } from '../protocol_response';

const remoteHmrClientPaths = new Set(['/@vite/client', '/bundledDevClient.mjs']);

/** Vite 的断线与运行时回退绕过服务端 full-reload 提示，只改 Remote 的两个开发客户端。 */
function remoteHmrClient(source: string): string {
  return source
    .replace('let bundledDevClient;', 'let bundledDevClient, weqClientId;')
    .replace(
      /const clientId = nanoid\(\);\s+transport\.send\(\{\s+type: "custom",\s+event: "vite:client-connected",\s+data: \{ clientId \}\s+\}\);/,
      'const clientId = weqClientId = nanoid();',
    )
    .replaceAll(
      'await maybePromise;\n\t\t\t\tconnectingPromise = void 0;',
      'await maybePromise.finally(() => { connectingPromise = void 0; });',
    )
    .replaceAll('onDisconnection();', 'clearInterval(pingIntervalId); onDisconnection();')
    .replace(
      /console\.log\(`\[vite\] server connection lost\. Polling for restart\.\.\.`\);\s+const socket = payload\.data\.webSocket;\s+const url = new URL\(socket\.url\);\s+url\.search = "";\s+await waitForSuccessfulPing\(url\.href\);\s+location\.reload\(\);/,
      'weqRetryHmr();',
    )
    .replaceAll(
      'location.reload();',
      `if (globalThis.__vite_is_fallback_page__) location.reload();
       else { window.weqRemoteReloadNeeded = true; window.dispatchEvent(new Event('weq-remote-reload-needed')); }`,
    )
    .replace(
      'transport.connect(createHMRHandler(handleMessage));',
      `let weqHmrTimer;
      function weqRetryHmr() {
        if (willUnload) return;
        clearTimeout(weqHmrTimer);
        weqHmrTimer = setTimeout(() => {
          if (document.hidden) document.addEventListener('visibilitychange', weqRetryHmr, {once:true});
          else void weqConnectHmr();
        }, 1500);
      }
      async function weqConnectHmr() {
        try {
          await transport.connect(createHMRHandler(handleMessage));
          if (weqClientId) {
            if (bundledDevClient) {
              await bundledDevClient.applyQueue;
              bundledDevClient.lastSeq = 0;
            }
            await transport.send({type:'custom',event:'vite:client-connected',data:{clientId:weqClientId}});
          }
        } catch { weqRetryHmr(); }
      }
      void weqConnectHmr();`,
    );
}

/** 仅开发入口显式启用；页面、模块与 HMR 都经原宿主认证，客户端无需访问环回端口。 */
export class DevelopmentWebProxy {
  private readonly target: URL;
  private readonly requests = new Set<ClientRequest>();
  private readonly sockets = new Set<Duplex>();
  private cachedRelease?: { source: string; document: ReturnType<typeof remoteReleaseDocument> };

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

  private request(req: IncomingMessage, release = false): ClientRequest {
    const headers = { ...req.headers, host: this.target.host };
    delete headers.cookie;
    delete headers.authorization;
    delete headers['accept-encoding'];
    if (release) {
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
    }
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
    const remote = /\bWeQRemote\b/.test(req.headers['user-agent'] ?? '');
    const path = (req.url ?? '').split('?')[0] ?? '';
    const release = remote && req.method === 'GET' && path === '/';
    const hmr = remote && req.method === 'GET' && remoteHmrClientPaths.has(path);
    return new Promise((resolve) => {
      const outgoing = this.request(req, release || hmr);
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
        const guardHmr = hmr && status === 200 && !html && !headers['content-encoding'];
        if ((!html && !guardHmr) || req.method === 'HEAD') {
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
          const source = Buffer.concat(chunks).toString('utf8');
          if (guardHmr) {
            const body = remoteHmrClient(source);
            delete headers['content-length'];
            delete headers.etag;
            headers['cache-control'] = 'no-store';
            headers.vary = [headers.vary, 'User-Agent', 'Accept-Encoding']
              .filter(Boolean)
              .join(', ');
            if (acceptsGzip(req.headers['accept-encoding'] ?? '')) {
              headers['content-encoding'] = 'gzip';
              res.writeHead(status, headers).end(gzipSync(body));
            } else res.writeHead(status, headers).end(body);
            return;
          }
          headers['content-type'] = 'text/html; charset=utf-8';
          delete headers['content-length'];
          delete headers.etag;
          if (release && status === 200) {
            let cached = this.cachedRelease;
            if (!cached || cached.source !== source) {
              cached = { source, document: remoteReleaseDocument(developmentHtml(source, true)) };
              this.cachedRelease = cached;
            }
            const { body, etag } = cached.document;
            headers.etag = etag;
            headers.vary = [headers.vary, 'User-Agent'].filter(Boolean).join(', ');
            const unchanged = matchesIfNoneMatch(req.headers['if-none-match'] ?? null, etag);
            res.writeHead(unchanged ? 304 : 200, headers).end(unchanged ? undefined : body);
          } else res.writeHead(status, headers).end(developmentHtml(source, remote));
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
      if (content) {
        const directives = content.value.split(';').map((directive) => {
          const parts = directive.trim().split(/\s+/);
          if (
            (parts[0] === 'script-src' || parts[0] === 'script-src-elem') &&
            !parts.includes("'unsafe-inline'")
          )
            parts.push("'unsafe-inline'");
          return parts;
        });
        if (remote) allowRemoteMedia(directives);
        content.value = directives.map((parts) => parts.join(' ')).join('; ');
      }
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
      `window.weqRemoteReloadNeeded=false;${startupManifest ? startupResourceTracker : ''}${developmentStartupProgress}`,
    );
    const first = head.childNodes.find(
      (node) => 'tagName' in node && (node.tagName === 'script' || node.tagName === 'link'),
    );
    if (first) defaultTreeAdapter.insertBefore(head, progress, first);
    else defaultTreeAdapter.appendChild(head, progress);
  }
  return serialize(document);
}
