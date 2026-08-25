/**
 * nt_msg.db file-watch hook — turns "the message db changed" into two signals:
 *
 *   1. `onDbChanged` — fired on EVERY observed change, even when no new rows
 *      arrived. This drives the open conversation's "re-read my loaded seq
 *      window" query, which is how group inserts (whose msgId can sort below an
 *      older gray-tip), recalls, and sticker reactions become visible.
 *
 *   2. `onNewMessages` — fired only when the diff finds newly *inserted* rows.
 *      This is the notification signal (unread badges / future popups).
 *
 * New-row detection uses `recent_contact_v3_table` as the watermark source
 * instead of the big msg tables, because neither `rowid` nor `msgId` there is a
 * reliable insert-order signal (observed live: a freshly-inserted group row can
 * sort below the table's max rowid/msgId, and `MAX(...)` baselines then
 * silently swallow it). The recent-contact table is small (the conversation
 * list) and QQ bumps a conversation's 40003 (last message seq) on every new
 * message, so it is a cheap, monotonic "something new arrived here" signal.
 *
 * Per change:
 *   - re-read the whole recent-contact list (small);
 *   - for each conversation whose 40003 grew past our watermark, fetch the new
 *     rows from `c2c_msg_table` / `group_msg_table` with the (40027,40003)
 *     composite index (`WHERE 40027 = ? AND 40003 > ?`) — never a full scan;
 *   - c2c rows resolve uid -> sortNo through the session's resident UidMap so
 *     the indexed 40027 partition is used (uid 40021 is unindexed);
 *   - advance that conversation's watermark only after a successful fetch.
 *
 * First run aligns the watermark map and emits nothing (a fresh mount must not
 * dump history at the UI). A conversation that first appears AFTER mount is
 * only pushed when its row is fresh (< 30s old) — i.e. a live new message — and
 * even then capped at the newest few rows; a revived old conversation is just
 * baselined silently.
 */

import type { AccountSession } from '@weq/account';
import { classifyChatType } from '@weq/codec';
import type { C2cMsg, GroupMsg } from '@weq/db';
import type { DbChange, DbWatchTask } from './db_watch';

/** Max rows pulled per conversation per change — guards against a stale watermark. */
const MAX_DELTA = 500;
/** For a conversation first seen after mount: push at most this many newest rows. */
const NEW_CONV_CAP = 5;
/** A recent-contact row counts as "live new message" when touched within this window. */
const NEW_CONV_FRESH_SEC = 30;

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
  /** Only when newly-inserted rows were found. */
  onNewMessages: (change: NewMessages) => void;
}

/** Per-conversation seq watermark, keyed by targetUid (40021). */
interface ConvWatermark {
  chatType: number;
  /** Latest 40003 already surfaced. */
  msgSeq: bigint;
  /** Latest 40050 seen (used by the fresh-new-conversation heuristic). */
  sendTime: bigint;
}

/** Fetched rows tagged by table so the caller can fan them into c2c/group. */
type Fetched = { kind: 'c2c'; msgs: C2cMsg[] } | { kind: 'group'; msgs: GroupMsg[] };

/**
 * Build a {@link DbWatchTask} for this account's `nt_msg.db`. Mount the
 * returned task on a `DbWatchService`. Wire `onDbChanged` to the renderer's
 * "refresh open conversation" path and `onNewMessages` to notifications.
 */
export function createNtMsgDbHook(session: AccountSession, hooks: NtMsgHooks): DbWatchTask {
  /** targetUid -> watermark. `null` until the first-run alignment. */
  let prev: Map<string, ConvWatermark> | null = null;

  return {
    dbPath: session.msgDbPath,
    onDbFileChangeHook: async (file: DbChange): Promise<void> => {
      // 1. Always: tell the open conversation to re-read its window.
      hooks.onDbChanged(file);

      // 2. Diff the recent-contact seq watermarks.
      const rows = await session.recentContacts.listSeqWatermarks();
      const current = new Map<string, ConvWatermark>();
      for (const r of rows) {
        if (!r.targetUid) continue;
        current.set(r.targetUid, {
          chatType: r.chatType,
          msgSeq: r.msgSeq,
          sendTime: r.sendTime,
        });
      }

      // First run: align to the current watermarks, emit nothing.
      if (prev === null) {
        prev = current;
        return;
      }

      const c2c: C2cMsg[] = [];
      const group: GroupMsg[] = [];
      // Everything we saw this poll is the next baseline; failed fetches are
      // reverted below so their rows are not lost.
      const next = new Map(current);

      for (const [uid, cur] of current) {
        const old = prev.get(uid);

        // Conversation first seen after mount: only a fresh row is a live
        // message; cap the push so a revived old conversation can't dump history.
        if (!old) {
          const isFresh = Date.now() / 1000 - Number(cur.sendTime) <= NEW_CONV_FRESH_SEC;
          if (isFresh) {
            const fetched = await fetchLatest(session, uid, cur.chatType);
            if (fetched) {
              for (const m of fetched.msgs) {
                if (Number(m.sendTime) < Number(cur.sendTime) - 1) continue;
                push(fetched.kind, m, c2c, group);
              }
            }
          }
          continue;
        }

        // Seq didn't grow (or rewound) — nothing new in this conversation.
        if (cur.msgSeq <= old.msgSeq) continue;

        try {
          const fetched = await fetchAfter(session, uid, cur.chatType, old.msgSeq);
          if (fetched) for (const m of fetched.msgs) push(fetched.kind, m, c2c, group);
        } catch {
          // Keep the old watermark so the rows are retried next change.
          next.set(uid, old);
        }
      }

      prev = next;

      // guild: no table wired yet — skipped via classifyChatType returning null.

      if (c2c.length > 0 || group.length > 0) {
        hooks.onNewMessages({ file, c2c: c2c.sort(compareNewest), group: group.sort(compareNewest) });
      }
    },
  };
}

/** Fetch rows strictly newer than `afterSeq` for one conversation (indexed). */
async function fetchAfter(
  session: AccountSession,
  uid: string,
  chatType: number,
  afterSeq: bigint,
): Promise<Fetched | null> {
  const kind = classifyChatType(chatType);
  if (kind === 'group') {
    return { kind: 'group', msgs: await session.groupMsgs.listAfter(uid, afterSeq, MAX_DELTA) };
  }
  if (kind === 'direct') {
    const part = c2cPartition(session, uid);
    return { kind: 'c2c', msgs: await session.c2cMsgs.listAfter(part, afterSeq, MAX_DELTA) };
  }
  // dataline / service / official / unknown — not wired.
  return null;
}

/** Fetch the newest rows of a conversation (indexed), for the fresh-new-conv path. */
async function fetchLatest(
  session: AccountSession,
  uid: string,
  chatType: number,
): Promise<Fetched | null> {
  const kind = classifyChatType(chatType);
  if (kind === 'group') {
    return { kind: 'group', msgs: await session.groupMsgs.listLatest(uid, NEW_CONV_CAP) };
  }
  if (kind === 'direct') {
    const part = c2cPartition(session, uid);
    return { kind: 'c2c', msgs: await session.c2cMsgs.listLatest(part, NEW_CONV_CAP) };
  }
  return null;
}

/** Prefer the indexed 40027 partition (sortNo); fall back to the uid scan. */
function c2cPartition(session: AccountSession, uid: string): { sortNo: bigint } | { uid: string } {
  const sortNo = session.uidMap.sortNoByUid(uid);
  return sortNo === undefined ? { uid } : { sortNo };
}

function push(
  kind: 'c2c' | 'group',
  m: C2cMsg | GroupMsg,
  c2c: C2cMsg[],
  group: GroupMsg[],
): void {
  if (kind === 'c2c') c2c.push(m as C2cMsg);
  else group.push(m as GroupMsg);
}

function compareNewest(a: { sendTime: bigint; msgId: bigint }, b: { sendTime: bigint; msgId: bigint }): number {
  if (a.sendTime !== b.sendTime) return a.sendTime < b.sendTime ? -1 : 1;
  if (a.msgId !== b.msgId) return a.msgId < b.msgId ? -1 : 1;
  return 0;
}