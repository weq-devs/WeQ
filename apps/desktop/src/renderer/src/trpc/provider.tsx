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
import { IS_WEB } from '../lib/target.shared';
import { isRemoteClient } from '../lib/remoteClient';
import { createQueryClient } from './queryClient';

export function TrpcProvider({ children }: { children: ReactNode }): ReactElement {
  const [queryClient] = useState(() => {
    const client = createQueryClient(IS_WEB);
    if (IS_WEB) configureBusinessCache(client);
    if (isRemoteClient()) {
      // 手机离线时立即交由连接壳反馈失败，恢复连接不排队提交写操作。
      const defaults = client.getDefaultOptions();
      client.setDefaultOptions({
        ...defaults,
        mutations: { ...defaults.mutations, networkMode: 'always' },
      });
    }
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
