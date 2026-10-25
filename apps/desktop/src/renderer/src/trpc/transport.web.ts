/**
 * tRPC transport — browser build.
 *
 * Queries and mutations go over HTTP; the 14 subscriptions ride a single
 * WebSocket (tRPC v10 has no SSE link). `splitLink` routes by operation type.
 *
 * A 401 means the session expired — reload so the server serves the login page
 * rather than leaving the UI stuck on failing requests.
 */

import { createWSClient, httpBatchLink, splitLink, wsLink, type TRPCLink } from '@trpc/client';
import type { AppRouter } from '../../../shared/router';
import { useWebConnection } from '../state/webConnection';

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

const wsClient = createWSClient({
  url: `${wsProtocol}//${location.host}/trpc-ws`,
  onOpen: () => useWebConnection.getState().connected(),
  onClose: () => useWebConnection.getState().disconnected(),
});

export function createLinks(): TRPCLink<AppRouter>[] {
  return [
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: wsLink({ client: wsClient }),
      false: httpBatchLink({
        url: '/trpc',
        maxURLLength: 2048,
        async fetch(input, init) {
          const res = await fetch(input, { ...init, credentials: 'same-origin' });
          if (res.status === 401) location.reload();
          return res;
        },
      }),
    }),
  ];
}
