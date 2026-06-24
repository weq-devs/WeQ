/**
 * Wraps the renderer tree with the trpc + react-query providers so
 * hooks like `trpc.bootstrap.describeInstall.useQuery()` work anywhere.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode, type ReactElement } from 'react';
import { trpc, trpcClient } from './client';

export function TrpcProvider({ children }: { children: ReactNode }): ReactElement {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Native QQ probes can block the Electron main process briefly.
          // Avoid re-running them just because the window regains focus.
          queries: {
            staleTime: 5 * 60_000,
            cacheTime: 30 * 60_000,
            refetchOnMount: false,
            refetchOnReconnect: false,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  // Reuse the single shared client from ./client — creating a second client
  // here would reintroduce the cross-talk between subscriptions (vanilla
  // `client`) and queries (React hooks). See the note in client.ts.
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
