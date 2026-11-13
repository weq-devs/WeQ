import { createWSClient, httpBatchLink, splitLink, wsLink } from '@trpc/client';
import { IS_WEB } from '../../src/renderer/src/lib/target';
export function createLinks() {
  const ws = createWSClient({
    url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/trpc-ws`,
  });
  return [
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: wsLink({ client: ws }),
      false: httpBatchLink({
        url: '/trpc',
        headers: () => (IS_WEB ? {} : { 'x-fixture-desktop': '1' }),
      }),
    }),
  ];
}
