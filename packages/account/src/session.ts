/**
 * `AccountContext` is intentionally *thin* — just the credentials and
 * resolved paths for one QQ account. It does NOT hold open db handles.
 *
 * The lifecycle object is `AccountSession`: handed a context, it opens
 * every db this account needs and exposes them as plain fields. Switch
 * accounts by `oldSession.dispose()` + `openAccount(ctx)` — there's no
 * shared mutable state between sessions.
 */

import { dirname, join } from 'node:path';
import { C2cMsgDb, GroupMsgDb, RecentContactDb, ForwardMsgDb, BuddyMsgFtsDb } from '@weq/db';
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
  /** Group-chat messages. */
  readonly groupMsgs: GroupMsgDb;
  /** Recent-conversation list. */
  readonly recentContacts: RecentContactDb;
  /** Merged-forward / quote-reply cache (40900 column). */
  readonly forwardMsgs: ForwardMsgDb;
  /** Full-text-search index over message text (buddy_msg_fts.db). */
  readonly buddyMsgFts: BuddyMsgFtsDb;
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

  const groupMsgs = new GroupMsgDb(platform.native.ntHelper, {
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

  // buddy_msg_fts.db sits next to nt_msg.db in the same nt_db folder. Trust
  // the platform lookup, but fall back to deriving it from msgDbPath so an
  // account whose index file isn't on disk yet still opens (search just errors
  // on first use rather than blocking the whole session).
  const ftsDbPath =
    platform.buddyMsgFtsDbPath(ctx.uin) ?? join(dirname(msgDbPath), 'buddy_msg_fts.db');

  const buddyMsgFts = new BuddyMsgFtsDb(platform.native.ntHelper, {
    dbPath: ftsDbPath,
    key: ctx.dbKey,
  });

  let disposed = false;
  return {
    context: ctx,
    c2cMsgs,
    groupMsgs,
    recentContacts,
    forwardMsgs,
    buddyMsgFts,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      c2cMsgs.close();
      groupMsgs.close();
      recentContacts.close();
      forwardMsgs.close();
      buddyMsgFts.close();
      // Future db instances close here too.
    },
  };
}
