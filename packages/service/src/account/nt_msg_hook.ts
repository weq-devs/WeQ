/**
 * nt_msg.db file-watch hook — turns "the message db changed" into two signals:
 *
 *   1. `onDbChanged` — fired on EVERY observed change, even when no new rows
 *      arrived. This drives the open conversation's "re-read my loaded seq
 *      window" query, which is how group inserts (whose msgId can sort below an
 *      older gray-tip), recalls, and sticker reactions become visible.
 *
 *   2. `onNewMessages` — fired only when a rowid-delta finds newly *inserted*
 *      rows. This is the notification signal (unread badges / future popups).
 *      rowid is used (not msgId) because msgId is not monotonic in groups; a
 *      new row always gets a larger rowid, so nothing is missed.
 *
 * Baseline (`session.lastRowIdMaps`) is owned entirely by this hook:
 *   - First run (baseline `0n`): align to the current max rowid, emit nothing
 *     (a fresh mount must not dump history at the UI).
 *   - Subsequent runs: emit rows with `rowid > baseline`, then advance the
 *     baseline to the current max rowid.
 */

import type { AccountSession, LastRowIdMaps } from '@weq/account';
import type { C2cMsg, GroupMsg } from '@weq/db';
import type { DbChange, DbWatchTask } from './db_watch';

/** Max rows pulled per chat type per change — guards against a stale baseline. */
const MAX_DELTA = 500;

/** Newly-inserted messages since the last baseline, per chat type. */
export interface NewMessages {
  /** The raw file change that triggered this diff (passthrough). */
  file: DbChange;
  /** New private-chat messages, oldest-first. */
  c2c: C2cMsg[];
  /** New group messages, oldest-first. */
  group: GroupMsg[];
}

/** The two sinks the watcher fans changes into. */
export interface NtMsgHooks {
  /** Every nt_msg.db change, regardless of whether new rows landed. */
  onDbChanged: (file: DbChange) => void;
  /** Only when newly-inserted rows were found (rowid-delta). */
  onNewMessages: (change: NewMessages) => void;
}

/**
 * Build a {@link DbWatchTask} for this account's `nt_msg.db`. Mount the
 * returned task on a `DbWatchService`. Wire `onDbChanged` to the renderer's
 * "refresh open conversation" path and `onNewMessages` to notifications.
 */
export function createNtMsgDbHook(session: AccountSession, hooks: NtMsgHooks): DbWatchTask {
  return {
    dbPath: session.msgDbPath,
    onDbFileChangeHook: async (file: DbChange): Promise<void> => {
      // 1. Always: tell the open conversation to re-read its window.
      hooks.onDbChanged(file);

      // 2. rowid-delta: detect genuinely new rows for the notification signal.
      const maps = session.lastRowIdMaps;
      const c2c = await diffByRowId(
        maps,
        'c2cRowId',
        () => session.c2cMsgs.latestRowId(),
        (since) => session.c2cMsgs.listSinceRowId(since, MAX_DELTA),
      );
      const group = await diffByRowId(
        maps,
        'groupRowId',
        () => session.groupMsgs.latestRowId(),
        (since) => session.groupMsgs.listSinceRowId(since, MAX_DELTA),
      );

      // guild: no table wired yet — maps.guildRowId stays reserved.

      if (c2c.length > 0 || group.length > 0) {
        hooks.onNewMessages({ file, c2c, group });
      }
    },
  };
}

/**
 * Shared rowid diff. Returns newly-inserted rows (empty on first-run baseline
 * alignment) and advances the baseline to the current max rowid.
 */
async function diffByRowId<M>(
  maps: LastRowIdMaps,
  key: keyof LastRowIdMaps,
  latestRowId: () => Promise<bigint>,
  listSinceRowId: (since: bigint) => Promise<M[]>,
): Promise<M[]> {
  const newMax = await latestRowId();
  const baseline = maps[key];

  // First run: align to current max, don't replay history.
  if (baseline === 0n) {
    maps[key] = newMax;
    return [];
  }
  if (newMax <= baseline) return [];

  const msgs = await listSinceRowId(baseline);
  maps[key] = newMax;
  return msgs;
}
