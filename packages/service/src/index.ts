/**
 * `@weq/service` — front-end facing services, split into two layers:
 *
 *   bootstrap/  — usable before any account is selected.
 *                 Take a `Platform` in their constructor.
 *                 (Detect / Key / UserConfig)
 *
 *   account/    — usable after `openAccount()` returned a session.
 *                 Take an `AccountSession` in their constructor.
 *                 (TestMsg, future Profile / Statistics / Report …)
 *
 * Lifecycle: bootstrap services are singletons living for the whole app.
 * Account services are short-lived — recreate on account switch alongside
 * the session.
 */

// ---- bootstrap ----
export { Win32DetectService } from './bootstrap/win32_detect';
export type { QqInstallInfo, DetectedQqProcess } from './bootstrap/win32_detect';

export { Win32KeyService } from './bootstrap/win32_key';
export type {
  KeyResult,
  KeyEvent,
  QuickLoginStreamOptions,
  QrLoginStreamOptions,
} from './bootstrap/win32_key';

export { UserConfigService } from './bootstrap/user_config';
export type { UserConfig } from './bootstrap/user_config';

// ---- account ----
export { TestMsgService } from './account/test_msg';
export { RecentContactService } from './account/recent_contact';
export { ForwardMsgService } from './account/forward';
export { MsgService } from './account/msg';
export { MsgSearchService } from './account/msg_search';

// A process-wide singleton (NOT bound to AccountSession): a single polling
// loop you mount/unmount db-watch tasks onto to watch their size for changes.
export { DbWatchService } from './account/db_watch';
export type {
  DbWatchOptions,
  DbChange,
  DbFileSize,
  DbChangeHook,
  DbWatchTask,
  DbWatchHandle,
} from './account/db_watch';

// nt_msg.db watch task: diffs new messages on file change (keeps the query
// out of the renderer). Mount the returned task on a DbWatchService.
export { createNtMsgDbHook } from './account/nt_msg_hook';
export type { NtMsgChange, NtMsgChangeCallback } from './account/nt_msg_hook';
export { bumpMaxMsgId } from './account/msg';
