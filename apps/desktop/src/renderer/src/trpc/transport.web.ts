/**
 * tRPC transport — browser build.
 *
 * Queries and mutations go over HTTP; the 14 subscriptions ride a single
 * WebSocket (tRPC v10 has no SSE link). `splitLink` routes by operation type.
 *
 * A 401 means the session expired — reload so the server serves the login page
 * rather than leaving the UI stuck on failing requests.
 */

import {
  createWSClient,
  httpBatchLink,
  httpLink,
  splitLink,
  wsLink,
  type TRPCLink,
} from '@trpc/client';
import type { AppRouter } from '../../../shared/router';
import { useWebConnection } from '../state/webConnection';

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

const wsClient = createWSClient({
  url: `${wsProtocol}//${location.host}/trpc-ws`,
  onOpen: () => useWebConnection.getState().connected(),
  onClose: () => useWebConnection.getState().disconnected(),
});

const independentReads = new Set([
  'account.searchQuick',
  'account.searchSlow',
  'account.listLatest',
  'account.listBefore',
  'account.listAfter',
  'account.listFrom',
  'account.cancelMessageRead',
]);

export function createLinks(): TRPCLink<AppRouter>[] {
  const httpOptions = {
    url: '/trpc',
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const res = await fetch(input, { ...init, credentials: 'same-origin' });
      if (res.status === 401) location.reload();
      return res;
    },
  };
  return [
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: wsLink({ client: wsClient }),
      false: splitLink({
        condition: (op) => independentReads.has(op.path),
        true: httpLink(httpOptions),
        false: httpBatchLink({ ...httpOptions, maxURLLength: 2048 }),
      }),
    }),
  ];
}
