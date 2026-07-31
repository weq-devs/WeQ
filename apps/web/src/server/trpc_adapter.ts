/**
 * tRPC transport for the web app.
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
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { WebSocketServer } from 'ws';
import type { AppRouter } from '@weq/desktop/main/ipc/router';
import type { AuthGate } from './auth';

/** HTTP handler for queries + mutations, mounted under `/trpc`. */
export function createTrpcHandler(
  router: AppRouter,
): (req: IncomingMessage, res: ServerResponse) => void {
  const handler = createHTTPHandler({
    router,
    createContext: () => ({}),
    onError({ error, path }) {
      console.error(`[trpc] ${path ?? '<no path>'}:`, error.message);
    },
  });
  return (req, res) => {
    // The standalone adapter wants the path relative to its mount point.
    const original = req.url ?? '/';
    req.url = original.slice('/trpc'.length) || '/';
    handler(req, res);
  };
}

/**
 * Attach the subscription WebSocket at `/trpc-ws`, gated on the same session
 * cookie as every HTTP route.
 */
export function attachWsHandler(server: Server, router: AppRouter, auth: AuthGate): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/trpc-ws') {
      socket.destroy();
      return;
    }
    if (!auth.isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  applyWSSHandler({
    wss,
    router,
    createContext: () => ({}),
    onError({ error, path }) {
      console.error(`[trpc-ws] ${path ?? '<no path>'}:`, error.message);
    },
  });
}
