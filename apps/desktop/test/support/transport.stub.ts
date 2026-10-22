/**
 * 单测用的 `@transport` 替身。
 *
 * `src/renderer/src/trpc/client.ts` 在模块加载时就会建 client，而 Electron 那份
 * transport（`transport.electron.ts`）走 `ipcLink()`，构造时要求 preload 暴露的
 * `globalThis.electronTRPC`；web 那份又会 `createWSClient` 连 WebSocket —— 两者在
 * 离线单测里都不该发生。这里给一条空链路：client 能正常构造，真正要发请求的用例
 * 各自 `vi.mock('../src/renderer/src/trpc/client')` 替掉。
 */

import type { TRPCLink } from '@trpc/client';
import type { AppRouter } from '../../../shared/router';

export function createLinks(): TRPCLink<AppRouter>[] {
  return [];
}
