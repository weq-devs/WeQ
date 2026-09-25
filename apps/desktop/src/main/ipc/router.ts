/**
 * Top-level router. `AppRouter` type is the contract the renderer uses
 * to derive end-to-end-typed tRPC clients.
 *
 * The three sub-routers split by lifecycle, NOT by URL aesthetics:
 *   - `bootstrap` — usable any time (read-only platform probes, dbkey
 *      acquisition, account open/close)
 *   - `account`   — requires a live AccountSession (msg / peer queries / annual report)
 *   - `update`    — in-app updates; the shell installs the implementation
 *      (`UpdateActions`), so this module stays Electron-free and the web app
 *      can mount the very same router.
 */

import { router } from './trpc';
import { bootstrapRouter } from './routers/bootstrap';
import { accountRouter } from './routers/account';
import { updateRouter } from './routers/update';
import { helpRouter } from './routers/help';
import { groupFeedbackRouter } from './routers/group_feedback';
import { wonderfulToolsRouter } from './routers/wonderful_tools';
import { dbRepairRouter } from './routers/db_repair';
import { mergeForwardRouter } from './routers/merge_forward';

export const appRouter = router({
  bootstrap: bootstrapRouter,
  account: accountRouter,
  update: updateRouter,
  help: helpRouter,
  groupFeedback: groupFeedbackRouter,
  wonderfulTools: wonderfulToolsRouter,
  /**
   * 妙妙工具 → 数据库修复。挂在顶层而不是 `account` 下：修库要在 QQ 与当前账号都
   * 不持有库的时候做，所以它不该要求"有活动会话"（见 routers/db_repair.ts 的头注）。
   */
  dbRepair: dbRepairRouter,
  /** 「合成聊天记录」草稿的本地持久化（合并转发发送由另一分支接入）。 */
  mergeForward: mergeForwardRouter,
});

export type AppRouter = typeof appRouter;
