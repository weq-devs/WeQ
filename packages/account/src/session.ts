/**
 * `AccountContext` is intentionally *thin* — just the credentials and
 * resolved paths for one QQ account. It does NOT hold open db handles.
 *
 * The lifecycle object is `AccountSession`: handed a context, it opens
 * every db this account needs and exposes them as plain fields. Switch
 * accounts by `oldSession.dispose()` + `openAccount(ctx)` — there's no
 * shared mutable state between sessions.
 */

import { C2cMsgDb, RecentContactDb, ForwardMsgDb } from '@weq/db';
import type { Platform } from '@weq/platform';

export interface AccountContext {
  /** Account QQ number. */
  uin: string;
  /** SQLCipher key for this account's databases (hex passphrase). */
  dbKey: string;
}

/**
 * One live account. Holds opened Db instances. Caller must `dispose()`
 * before opening another account (or on app shutdown) to drop the cached
 * native connections.
 */
export interface AccountSession {
  readonly context: AccountContext;
  /** Private-chat messages. */
  readonly c2cMsgs: C2cMsgDb;
  /** Recent-conversation list. */
  readonly recentContacts: RecentContactDb;
  /** Merged-forward / quote-reply cache (40900 column). */
  readonly forwardMsgs: ForwardMsgDb;
  /** Close every db this session opened. Idempotent. */
  dispose(): void;
}

export function openAccount(platform: Platform, ctx: AccountContext): AccountSession {
  const msgDbPath = platform.ntMsgDbPath(ctx.uin);
  if (!msgDbPath) {
    throw new Error(`nt_msg.db not found for uin=${ctx.uin}`);
  }

  const c2cMsgs = new C2cMsgDb(platform.native.ntHelper, {
    dbPath: msgDbPath,
    key: ctx.dbKey,
  });

  const recentContacts = new RecentContactDb(platform.native.ntHelper, {
    dbPath: msgDbPath,
    key: ctx.dbKey,
  });

  const forwardMsgs = new ForwardMsgDb(platform.native.ntHelper, {
    dbPath: msgDbPath,
    key: ctx.dbKey,
  });

  let disposed = false;
  return {
    context: ctx,
    c2cMsgs,
    recentContacts,
    forwardMsgs,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      c2cMsgs.close();
      recentContacts.close();
      forwardMsgs.close();
      // Future db instances close here too.
    },
  };
}
