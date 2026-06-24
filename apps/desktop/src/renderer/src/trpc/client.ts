/**
 * tRPC client + React Query glue for the renderer.
 *
 * - `ipcLink` from `electron-trpc/renderer` carries calls over the IPC
 *   bridge set up in the preload.
 * - Uses superjson transformer (matches server-side config).
 *
 * Exports:
 *   - `trpc`       — React hooks via createTRPCReact<AppRouter>()
 *   - `trpcClient` — the single underlying client; fed to <trpc.Provider>
 *   - `client`     — vanilla proxy over the SAME underlying client, for
 *                    imperative calls / subscriptions outside React
 *
 * IMPORTANT — there must be exactly ONE underlying client. electron-trpc routes
 * every response purely by the tRPC operation `id` over a single broadcast IPC
 * channel, and each `TRPCUntypedClient` counts its request ids from 0
 * independently. Two separate clients (e.g. a standalone `createTRPCProxyClient`
 * plus the React client) therefore share one id space over one channel: every
 * IpcClient receives every response, so a query reply on one client is
 * delivered into a still-open subscription on the OTHER client whenever their
 * ids coincide. That misrouting is exactly how a `getSelfProfile` payload ended
 * up arriving on the `onAccountForcedClosed` subscription. Building `client`
 * from the React client's untyped instance keeps a single id space and a single
 * IpcClient, which fixes it.
 */

import { createTRPCReact } from '@trpc/react-query';
import { createTRPCClientProxy, type TRPCLink } from '@trpc/client';
import { ipcLink } from 'electron-trpc/renderer';
import superjson from 'superjson';
import type { AppRouter } from '../../../shared/router';

export const trpc = createTRPCReact<AppRouter>();

/**
 * The single underlying (untyped) client for the whole renderer. Passed to
 * <trpc.Provider> in provider.tsx; do NOT call `trpc.createClient` a second
 * time — every consumer must share this one instance / id space.
 */
export const trpcClient = trpc.createClient({
  links: [ipcLink() as unknown as TRPCLink<AppRouter>],
  transformer: superjson,
});

/**
 * Vanilla proxy for imperative use (subscriptions / one-off calls outside
 * React), wrapping the SAME underlying client as the React hooks so there is a
 * single request-id space over the shared IPC channel.
 */
export const client = createTRPCClientProxy(trpcClient);
