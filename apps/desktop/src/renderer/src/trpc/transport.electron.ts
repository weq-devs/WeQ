/**
 * tRPC transport — Electron build.
 *
 * `ipcLink` carries every call over the IPC bridge set up in the preload.
 * The web build resolves `@transport` to `transport.web.ts` instead; see the
 * alias in each app's vite config.
 */

import type { TRPCLink } from '@trpc/client';
import { ipcLink } from 'electron-trpc/renderer';
import type { AppRouter } from '../../../shared/router';

export function createLinks(): TRPCLink<AppRouter>[] {
  return [ipcLink() as unknown as TRPCLink<AppRouter>];
}
