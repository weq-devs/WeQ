/**
 * 独立 Web 与桌面内置 Web 共用的 tRPC 传输。
 *
 * The router itself (259 procedures) is reused verbatim from the desktop app —
 * only the transport differs: `electron-trpc`'s IPC link becomes plain HTTP for
 * queries/mutations, plus a WebSocket for the 14 subscriptions (tRPC v10 has no
 * SSE link, and a single socket covers all of them).
 *
 * The WebSocket upgrade re-checks the session cookie: without that, the socket
 * would be an unauthenticated side door straight into the router.
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { TRPCError, type AnyRouter } from '@trpc/server';
import type { HostBridge } from '@weq/service';
import { logTransportError } from '@weq/service';
import { WebSocketServer } from 'ws';
import type { AuthGate } from './auth';

// 单图上传允许 14 MiB base64；附件使用既有分段入口。批量只用于读取。
export const HTTP_RPC_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** HTTP handler for queries + mutations, mounted under `/trpc`. */
export function createTrpcHandler(
  router: AnyRouter,
  auth?: Pick<AuthGate, 'isAuthed'>,
  host?: HostBridge,
): (req: IncomingMessage, res: ServerResponse) => void {
  const handler = createHTTPHandler({
    router,
    maxBodySize: HTTP_RPC_MAX_BODY_BYTES,
    onError: ({ error, path }) => logTransportError('trpc-http', path, error),
    createContext: ({ req }) => ({
      networkClientId:
        typeof req.headers['x-weq-client-id'] === 'string'
          ? req.headers['x-weq-client-id']
          : undefined,
      host,
      authorize: auth
        ? () => {
            if (!auth.isAuthed(req)) throw new TRPCError({ code: 'UNAUTHORIZED' });
          }
        : undefined,
    }),
  });
  return (req, res) => {
    const invoke = () => {
      const original = req.url ?? '/';
      req.url = original.slice('/trpc'.length) || '/';
      handler(req, res);
    };
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      !req.headers['content-length'] &&
      !req.headers['transfer-encoding']
    ) {
      invoke();
      return;
    }
    let chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      chunks = [];
      req.off('data', data);
      req.off('end', end);
      req.off('aborted', cleanup);
      req.off('error', cleanup);
    };
    const reject = (status: 400 | 413) => {
      cleanup();
      req.pause();
      const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'PARSE_ERROR';
      const error = new TRPCError({
        code,
        message:
          status === 413 ? '请求正文超过 16 MiB 上限，请使用附件分段上传。' : '请求 JSON 无效',
      });
      const result = {
        error: router._def._config.transformer.output.serialize(
          router.getErrorShape({
            error,
            type: req.method === 'GET' ? 'query' : 'mutation',
            path: undefined,
            input: undefined,
            ctx: undefined,
          }),
        ),
      };
      const url = new URL(req.url ?? '/', 'http://localhost');
      const body =
        url.searchParams.get('batch') === '1'
          ? url.pathname
              .split('/')
              .at(-1)!
              .split(',')
              .map(() => result)
          : result;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      // 先送达错误响应；暂停读取期间不再累积正文，随后关闭不可复用的连接。
      const closing = setTimeout(() => req.destroy(), 250);
      closing.unref();
      req.once('close', () => clearTimeout(closing));
      res.end(JSON.stringify(body));
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > HTTP_RPC_MAX_BODY_BYTES) {
        reject(413);
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      const text = Buffer.concat(chunks, bytes).toString('utf8');
      cleanup();
      try {
        Object.assign(req, {
          body: req.headers['content-type']?.startsWith('application/json')
            ? text
              ? JSON.parse(text)
              : undefined
            : text || undefined,
        });
      } catch {
        reject(400);
        return;
      }
      invoke();
    };
    if (Number(req.headers['content-length'] ?? 0) > HTTP_RPC_MAX_BODY_BYTES) {
      reject(413);
      return;
    }
    req.on('data', data);
    req.once('end', end);
    req.once('aborted', cleanup);
    req.once('error', cleanup);
  };
}

/**
 * Attach the subscription WebSocket at `/trpc-ws`, gated on the same session
 * cookie as every HTTP route.
 */
export function attachWsHandler(
  server: Server,
  router: AnyRouter,
  auth: Pick<AuthGate, 'isAuthed' | 'watchSession'>,
  host?: HostBridge,
  extraUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean,
): () => void {
  const wss = new WebSocketServer({ noServer: true });

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/trpc-ws') {
      if (extraUpgrade?.(req, socket, head)) return;
      socket.destroy();
      return;
    }
    if (!auth.isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const unwatch = auth.watchSession(req, () => ws.terminate());
      ws.once('close', unwatch);
      wss.emit('connection', ws, req);
    });
  };
  server.on('upgrade', upgrade);

  applyWSSHandler({
    wss,
    router,
    onError: ({ error, path }) => logTransportError('trpc-ws', path, error),
    createContext: ({ req }) => ({
      host,
      authorize: () => {
        if (!auth.isAuthed(req)) throw new TRPCError({ code: 'UNAUTHORIZED' });
      },
    }),
  });
  return () => {
    server.off('upgrade', upgrade);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}
