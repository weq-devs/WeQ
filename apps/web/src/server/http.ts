/**
 * The web app's HTTP server.
 *
 * Routing, in order:
 *   /_auth/login   POST   — the only unauthenticated endpoint
 *   /_auth/logout  POST
 *   /trpc/*               — tRPC over HTTP (259 procedures, unchanged)
 *   /_media/*             — weq-media:// handler
 *   /_avatar/*            — weq-avatar:// handler
 *   /_asset/*             — weq-asset:// handler
 *   /_download/:id        — files produced by HostBridge.pickSaveTarget
 *   everything else       — the built SPA (index.html fallback)
 *
 * Everything except the login endpoint and the login page is behind
 * {@link AuthGate}. Port binding mirrors `main/mcp/server.ts`: probe forward
 * from the requested port so a squatter (Windows loves these) doesn't stop us.
 */

import http from 'node:http';
import { type AuthGate, peerKey } from './auth';
import { LOGIN_PAGE } from './login_page';
import { toProtocolRequest, writeResponse } from './protocol_adapter';
import { lookupDownload } from './host';
import { serveStatic } from './static';
import { handleMediaRequest } from '@weq/desktop/main/media_protocol';
import { handleAvatarRequest } from '@weq/desktop/main/avatar_protocol';
import { handleResourceRequest } from '@weq/desktop/main/resource_protocol';
import { fileResponse } from '@weq/desktop/main/file_response';

const PORT_FALLBACK_ATTEMPTS = 10;
/** Refuse absurd login bodies outright. */
const MAX_LOGIN_BODY = 4096;

export interface ServerOptions {
  port: number;
  host: string;
  publicDir: string;
  auth: AuthGate;
  /** Mounted at /trpc — created in index.ts so this file stays transport-only. */
  trpc: (req: http.IncomingMessage, res: http.ServerResponse) => void;
}

/** Read a JSON body, refusing anything oversized. */
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_LOGIN_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: http.ServerResponse, status: number, body: string, type = 'text/plain'): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(body);
}

/** Map a URL prefix onto one of the reused protocol handlers. */
const PROTOCOL_ROUTES: Array<{
  prefix: string;
  scheme: string;
  handle: (req: Request) => Promise<Response>;
}> = [
  { prefix: '/_media', scheme: 'weq-media', handle: handleMediaRequest },
  { prefix: '/_avatar', scheme: 'weq-avatar', handle: handleAvatarRequest },
  { prefix: '/_asset', scheme: 'weq-asset', handle: handleResourceRequest },
];

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ServerOptions,
): Promise<void> {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';

  // ---- unauthenticated surface (exactly two entries) ----
  if (path === '/_auth/login') {
    if (req.method !== 'POST') return send(res, 405, 'method not allowed');
    let token = '';
    try {
      const body = await readJson(req);
      token =
        typeof (body as { token?: unknown })?.token === 'string'
          ? (body as { token: string }).token
          : '';
    } catch {
      return send(res, 400, 'bad request');
    }
    const ok = await opts.auth.login(token, peerKey(req), res);
    return send(res, ok ? 200 : 401, ok ? 'ok' : 'unauthorized');
  }

  const authed = opts.auth.isAuthed(req);

  if (path === '/_auth/logout') {
    opts.auth.logout(req, res);
    return send(res, 200, 'ok');
  }

  // ---- the gate ----
  if (!authed) {
    // A browser navigating to any page gets the login form; anything else
    // (XHR, media, tRPC) gets a plain 401 so the client can react.
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(LOGIN_PAGE);
      return;
    }
    return send(res, 401, 'unauthorized');
  }

  // ---- authenticated routes ----
  if (path.startsWith('/trpc')) {
    opts.trpc(req, res);
    return;
  }

  for (const route of PROTOCOL_ROUTES) {
    if (path !== route.prefix && !path.startsWith(`${route.prefix}/`)) continue;
    const protoReq = toProtocolRequest(req, route.scheme, route.prefix);
    if (!protoReq) return send(res, 400, 'bad request');
    const out = await route.handle(protoReq);
    return writeResponse(res, out);
  }

  if (path.startsWith('/_download/')) {
    const id = path.slice('/_download/'.length);
    const entry = lookupDownload(id);
    if (!entry) return send(res, 404, 'not found');
    const out = await fileResponse(entry.path);
    const headers = new Headers(out.headers);
    headers.set(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    );
    return writeResponse(res, new Response(out.body, { status: out.status, headers }));
  }

  await serveStatic(res, opts.publicDir, url);
}

/** Bind `server` to `port`, resolving false when the port is taken. */
function tryListen(server: http.Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startServer(
  opts: ServerOptions,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, opts).catch((e) => {
      console.error('[web] request failed:', e);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.destroy();
    });
  });

  for (let i = 0; i < PORT_FALLBACK_ATTEMPTS; i += 1) {
    const port = opts.port + i;
    if (port > 65535) break;
    if (await tryListen(server, port, opts.host)) return { server, port };
    if (i > 0) console.warn(`[web] port ${port} in use, trying next`);
  }

  server.close();
  throw new Error(
    `端口 ${opts.port}–${Math.min(opts.port + PORT_FALLBACK_ATTEMPTS - 1, 65535)} 都被占用，无法启动。`,
  );
}
