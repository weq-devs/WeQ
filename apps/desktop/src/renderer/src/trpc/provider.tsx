/**
 * Wraps the renderer tree with the trpc + react-query providers so
 * hooks like `trpc.bootstrap.describeInstall.useQuery()` work anywhere.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode, type ReactElement } from 'react';
import { registerDiagnosticQueries } from '../lib/resourceDiagnostics';
import { trpc, trpcClient } from './client';
import { WebStartupCache } from '../lib/webStartupCache';
import { installDevelopmentTiming } from '../lib/developmentTiming';
import { configureBusinessCache } from '../lib/webBusinessCache';
import { IS_WEB } from '../lib/target';
import { createQueryClient } from './queryClient';

export function TrpcProvider({ children }: { children: ReactNode }): ReactElement {
  const [queryClient] = useState(() => {
    const client = createQueryClient(IS_WEB);
    if (IS_WEB) configureBusinessCache(client);
    return client;
  });
  useEffect(() => {
    const stopQueries = registerDiagnosticQueries(queryClient);
    const stopTiming = installDevelopmentTiming(window, import.meta.env.DEV);
    return () => {
      stopTiming();
      stopQueries();
    };
  }, [queryClient]);
  // Reuse the single shared client from ./client — creating a second client
  // here would reintroduce the cross-talk between subscriptions (vanilla
  // `client`) and queries (React hooks). See the note in client.ts.
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WebStartupCache.Provider value={queryClient}>{children}</WebStartupCache.Provider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
