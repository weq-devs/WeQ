/**
 * WeqBot daemon 的宿主侧入口。
 *
 * 单例：desktop 主进程里只有一个 `BotRuntime`，它持有 `Map<uin, daemon>`。
 * 被 `ipc/routers/bootstrap.ts` 与 `context/app_context.ts` 共用。
 */

import { BotRuntime } from './manager';

export const botRuntime = new BotRuntime();

export { BotRuntime } from './manager';
export { resolveDaemonPaths } from './paths';
export type { BotRuntimeOptions, OneBotEventListener } from './manager';
