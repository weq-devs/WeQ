/**
 * nt_msg.db file-watch hook — turns "the message db grew" into "here are the
 * new messages", keeping that query out of the renderer.
 *
 * Strategy (deliberately simplified for now): treat msgId (column 40001) as
 * monotonically increasing per chat type. On each file change, diff the
 * table's current rows against the baseline in `session.lastMsgIdMaps` and
 * emit whatever is newer, then advance the baseline.
 *
 *   - First run (baseline still `0n`, i.e. nothing has read "latest" yet):
 *     just align the baseline to the current max msgId. We do NOT replay the
 *     whole table — a fresh mount shouldn't dump history at the UI.
 *   - Subsequent runs: `listSince(baseline)` → emit → bump baseline to the
 *     newest msgId returned.
 *
 * Baseline writes are monotonic (`max`) so a concurrent "latest"-reading
 * query service that already advanced the baseline can't be clobbered back.
 *
 * NOT handled yet (documented so the gap is explicit): recalls / edits /
 * upload-complete and other in-place row mutations that don't add a larger
 * msgId, and guild messages (no table wired). The hook signature leaves room
 * to grow into those without touching the watcher.
 */

import type { AccountSession } from '@weq/account';
import type { C2cMsg, GroupMsg } from '@weq/db';
import type { DbChange, DbWatchTask } from './db_watch';

/** Max rows pulled per chat type per change — guards against a stale baseline. */
const MAX_DELTA = 500;

/** Structured result the hook produces and hands to its `onChange` sink. */
export interface NtMsgChange {
  /** The raw file-size change that triggered this diff (passthrough). */
  file: DbChange;
  /** New private-chat messages since the last baseline, oldest-first. */
  c2c: C2cMsg[];
  /** New group messages since the last baseline, oldest-first. */
  group: GroupMsg[];
}

export type NtMsgChangeCallback = (change: NtMsgChange) => void;

/**
 * Build a {@link DbWatchTask} for this account's `nt_msg.db`. Mount the
 * returned task on a `DbWatchService`; `onChange` is invoked only when the
 * diff actually found new messages (so the UI sink can stay dumb). Wire
 * `onChange` to a tRPC subscription's `emit.next` to push to the renderer.
 */
export function createNtMsgDbHook(
  session: AccountSession,
  onChange: NtMsgChangeCallback,
): DbWatchTask {
  return {
    dbPath: session.msgDbPath,
    onDbFileChangeHook: async (file: DbChange): Promise<void> => {
      const maps = session.lastMsgIdMaps;

      const c2c = await diffChatType(
        maps.c2cMsgId,
        () => session.c2cMsgs.latestMsgId(),
        (since) => session.c2cMsgs.listSince(since, MAX_DELTA),
        (newest) => {
          if (newest > maps.c2cMsgId) maps.c2cMsgId = newest;
        },
      );

      const group = await diffChatType(
        maps.groupMsgId,
        () => session.groupMsgs.latestMsgId(),
        (since) => session.groupMsgs.listSince(since, MAX_DELTA),
        (newest) => {
          if (newest > maps.groupMsgId) maps.groupMsgId = newest;
        },
      );

      // guild: no table wired yet — maps.guildMsgId stays reserved.

      if (c2c.length > 0 || group.length > 0) {
        onChange({ file, c2c, group });
      }
    },
  };
}

/**
 * Shared c2c/group diff. Returns the new messages (empty on first-run
 * baseline alignment) and advances the baseline via `bump`.
 */
async function diffChatType<M extends { msgId: bigint }>(
  baseline: bigint,
  latestMsgId: () => Promise<bigint>,
  listSince: (since: bigint) => Promise<M[]>,
  bump: (newest: bigint) => void,
): Promise<M[]> {
  // First run: align to current max, don't replay history.
  if (baseline === 0n) {
    bump(await latestMsgId());
    return [];
  }
  const msgs = await listSince(baseline);
  const newest = msgs[msgs.length - 1]?.msgId; // ASC → last is largest
  if (newest !== undefined) bump(newest);
  return msgs;
}
