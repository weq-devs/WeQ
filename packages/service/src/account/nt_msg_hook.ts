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
import { classifyChatType, compareMessageOrder } from '@weq/codec';
import type { C2cMsg, GroupMsg } from '@weq/db';
import type { DbChange, DbWatchTask } from './db_watch';

/** Page size for reading a conversation's new rows without truncating a burst. */
const MAX_DELTA = 500;
/** For a conversation first seen after mount: push at most this many newest rows. */
const NEW_CONV_CAP = 5;
/** A recent-contact row counts as "live new message" when touched within this window. */
export const NEW_CONV_FRESH_SEC = 30;

/** Newly-inserted messages since the last baseline, per chat type. */
export interface NewMessages {
  /** The raw file change that triggered this diff (passthrough). */
  file: DbChange;
  /** New private-chat messages, oldest-first. */
  c2c: C2cMsg[];
  /** New group messages, oldest-first. */
  group: GroupMsg[];
  /** 设备表独立标注来源类型，不冒充好友入站。 */
  dataline?: Array<C2cMsg & { chatType: number }>;
}

/** The two sinks the watcher fans changes into. */
export interface NtMsgHooks {
  /** Every nt_msg.db change, regardless of whether new rows landed. */
  onDbChanged: (file: DbChange) => void;
  /** Only when newly-inserted rows were found. */
  onNewMessages: (change: NewMessages) => void | Promise<void>;
}

/** Per-conversation seq watermark, keyed by targetUid (40021). */
interface ConvWatermark {
  uid: string;
  chatType: number;
  /** Latest 40003 already surfaced. */
  msgSeq: bigint;
  /** Latest 40050 seen (used by the fresh-new-conversation heuristic). */
  sendTime: bigint;
}

/** Fetched rows tagged by table so the caller can fan them into c2c/group. */
type Fetched =
  | { kind: 'c2c'; msgs: C2cMsg[] }
  | { kind: 'group'; msgs: GroupMsg[] }
  | { kind: 'dataline'; chatType: number; msgs: C2cMsg[] };

/**
 * Build a {@link DbWatchTask} for this account's `nt_msg.db`. Mount the
 * returned task on a `DbWatchService`. Wire `onDbChanged` to the renderer's
 * "refresh open conversation" path and `onNewMessages` to notifications.
 */
export function createNtMsgDbHook(session: AccountSession, hooks: NtMsgHooks): DbWatchTask {
  /** targetUid -> watermark. `null` until the first-run alignment. */
  let prev: Map<string, ConvWatermark> | null = null;
  const queue = new Map<string, ConvWatermark>();
  const freshTargets = new Set<string>();
  const retries = new Map<string, { failures: number; at: number }>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let pending = false;
  let latestFile: DbChange | undefined;
  const arm = (delay: number) => {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void request();
    }, delay);
    timer.unref();
  };
  // 挂载即取基线，不能等第一条新消息触发文件变化后才把它当历史吞掉。
  const initial = session.recentContacts
    .listSeqWatermarks()
    .then((rows) => {
      prev = new Map(
        rows
          .filter((row) => row.targetUid)
          .map((row) => [
            `${row.chatType}:${row.targetUid}`,
            {
              uid: row.targetUid,
              chatType: row.chatType,
              msgSeq: row.msgSeq,
              sendTime: row.sendTime,
            },
          ]),
      );
    })
    .catch(() => {});

  async function pass(file: DbChange): Promise<void> {
    await initial;
    if (disposed) return;

    // 2. Diff the recent-contact seq watermarks.
    const rows = await session.recentContacts.listSeqWatermarks();
    if (disposed) return;
    const current = new Map<string, ConvWatermark>();
    for (const r of rows) {
      if (!r.targetUid) continue;
      current.set(`${r.chatType}:${r.targetUid}`, {
        uid: r.targetUid,
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

    const previous = prev;
    for (const key of previous.keys()) if (!current.has(key)) previous.delete(key);

    // 优先当前新消息，不让旧会话补齐排在它前面。
    const prioritized = [...current]
      .filter(([key, cur]) => {
        const old = previous.get(key);
        return !old || cur.msgSeq > old.msgSeq;
      })
      .sort(([, a], [, b]) => (a.sendTime > b.sendTime ? -1 : a.sendTime < b.sendTime ? 1 : 0));
    for (const [key, cur] of prioritized) {
      if (!previous.has(key) && Date.now() / 1000 - Number(cur.sendTime) <= NEW_CONV_FRESH_SEC)
        freshTargets.add(key);
      queue.set(key, cur);
    }
    for (const key of queue.keys()) {
      if (!current.has(key)) {
        queue.delete(key);
        retries.delete(key);
        freshTargets.delete(key);
      }
    }
    // 每个会话每轮一页，最多八页；积压会话排到队尾，健康目标不等失败退避。
    let budget = 8;
    for (const [key, cur] of [...queue]) {
      if (disposed || budget <= 0) break;
      if ((retries.get(key)?.at ?? 0) > Date.now()) continue;
      budget--;
      queue.delete(key);
      const c2c: C2cMsg[] = [];
      const group: GroupMsg[] = [];
      const dataline: NonNullable<NewMessages['dataline']> = [];
      const emit = async () => {
        if (disposed) return;
        if (!c2c.length && !group.length && !dataline.length) return;
        await hooks.onNewMessages({
          file,
          c2c: c2c.sort(compareMessageOrder),
          group: group.sort(compareMessageOrder),
          ...(dataline.length ? { dataline: dataline.sort(compareMessageOrder) } : {}),
        });
      };
      const uid = cur.uid;
      const old = previous.get(key);

      const retry = () => {
        const failures = Math.min(6, (retries.get(key)?.failures ?? 0) + 1);
        retries.set(key, {
          failures,
          at: Date.now() + Math.min(1000 * 2 ** (failures - 1), 30000),
        });
        queue.set(key, cur);
      };

      // Conversation first seen after mount: only a fresh row is a live
      // message; cap the push so a revived old conversation can't dump history.
      if (!old) {
        const isFresh = freshTargets.has(key);
        if (isFresh) {
          let fetched: Fetched | null;
          try {
            fetched = await fetchLatest(session, uid, cur.chatType);
          } catch {
            retry();
            continue;
          }
          if (fetched) {
            const observed = fetched.msgs.reduce(
              (max, msg) => (msg.msgSeq > max ? msg.msgSeq : max),
              0n,
            );
            for (const m of fetched.msgs) {
              if (Number(m.sendTime) < Number(cur.sendTime) - 1) continue;
              if (fetched.kind === 'dataline')
                dataline.push({ ...(m as C2cMsg), chatType: fetched.chatType });
              else push(fetched.kind, m, c2c, group);
            }
            try {
              await emit();
            } catch {
              retry();
              continue;
            }
            if (disposed) return;
            if (observed === 0n) {
              retry();
              continue;
            }
            previous.set(key, { ...cur, msgSeq: observed });
            freshTargets.delete(key);
            if (observed < cur.msgSeq) queue.set(key, cur);
            retries.delete(key);
            continue;
          }
        }
        previous.set(key, cur);
        freshTargets.delete(key);
        retries.delete(key);
        continue;
      }

      try {
        const fetched = await fetchAfter(session, uid, cur.chatType, old.msgSeq);
        if (fetched) {
          const observed = fetched.msgs.reduce(
            (max, msg) => (msg.msgSeq > max ? msg.msgSeq : max),
            old.msgSeq,
          );
          for (const m of fetched.msgs) {
            if (fetched.kind === 'dataline')
              dataline.push({ ...(m as C2cMsg), chatType: fetched.chatType });
            else push(fetched.kind, m, c2c, group);
          }
          await emit();
          if (disposed) return;
          previous.set(key, { ...cur, msgSeq: observed });
          if (observed < cur.msgSeq) {
            if (observed === old.msgSeq) retry();
            else {
              retries.delete(key);
              queue.set(key, cur);
            }
          } else retries.delete(key);
        } else previous.set(key, cur);
      } catch {
        retry();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (queue.size)
      arm(
        Math.max(
          0,
          Math.min(...[...queue.keys()].map((key) => retries.get(key)?.at ?? 0)) - Date.now(),
        ),
      );
  }

  function request(): Promise<void> {
    if (disposed) return Promise.resolve();
    pending = true;
    if (running) return running;
    running = Promise.resolve().then(async () => {
      try {
        do {
          pending = false;
          if (latestFile) await pass(latestFile);
        } while (pending && !disposed);
      } catch {
        // 水位读取失败也独立重试，不等待下一次文件签名变化。
        arm(1000);
      } finally {
        running = undefined;
      }
    });
    return running;
  }

  return {
    dbPath: session.msgDbPath,
    onDbFileChangeHook(file) {
      if (disposed) return;
      hooks.onDbChanged(file);
      latestFile = file;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      return request();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      queue.clear();
      retries.clear();
      freshTargets.clear();
    },
  };
}

/**
 * 读取单页并补齐边界同序号记录；下一页由公平队列续作。
 * A full page may end inside a repeated msgSeq (e.g. a gray-tip sharing the
 * seq of a real message), so include any remaining rows of that boundary seq
 * before advancing the exclusive seq cursor.
 */
async function drainAfter<T extends { msgSeq: bigint; msgId: bigint }>(
  afterSeq: bigint,
  listPage: (seq: bigint) => Promise<T[]>,
  listBoundary: (seq: bigint) => Promise<T[]>,
): Promise<T[]> {
  const collected: T[] = [];
  const page = await listPage(afterSeq);
  if (page.length === 0) return collected;
  collected.push(...page);
  if (page.length < MAX_DELTA) return collected;

  const boundarySeq = page[page.length - 1]!.msgSeq;
  if (boundarySeq <= afterSeq) throw new Error('新消息分页游标未前进');

  const seen = new Set(page.filter((m) => m.msgSeq === boundarySeq).map((m) => m.msgId));
  for (const m of await listBoundary(boundarySeq)) {
    if (m.msgSeq !== boundarySeq || seen.has(m.msgId)) continue;
    seen.add(m.msgId);
    collected.push(m);
  }
  return collected;
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
    return {
      kind: 'group',
      msgs: await drainAfter(
        afterSeq,
        (cursor) => session.groupMsgs.listAfter(uid, cursor, MAX_DELTA),
        (seq) => session.groupMsgs.listBySeqsInPartition(uid, [seq]),
      ),
    };
  }
  if (kind === 'direct') {
    const part = c2cPartition(session, uid);
    return {
      kind: 'c2c',
      msgs: await drainAfter(
        afterSeq,
        (cursor) => session.c2cMsgs.listAfter(part, cursor, MAX_DELTA),
        (seq) => session.c2cMsgs.listBySeqsInPartition(part, [seq]),
      ),
    };
  }
  if (kind === 'dataline') {
    const part = c2cPartition(session, uid);
    return {
      kind: 'dataline',
      chatType,
      msgs: await drainAfter(
        afterSeq,
        (cursor) => session.datalineMsgs.listAfter(part, cursor, MAX_DELTA),
        (seq) => session.datalineMsgs.listBySeqsInPartition(part, [seq]),
      ),
    };
  }
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
  if (kind === 'dataline')
    return {
      kind: 'dataline',
      chatType,
      msgs: await session.datalineMsgs.listLatest(c2cPartition(session, uid), NEW_CONV_CAP),
    };
  return null;
}

/** Prefer the indexed 40027 partition (sortNo); fall back to the uid scan. */
function c2cPartition(session: AccountSession, uid: string): { sortNo: bigint } | { uid: string } {
  const sortNo = session.uidMap.sortNoByUid(uid);
  return sortNo === undefined ? { uid } : { sortNo };
}

function push(kind: 'c2c' | 'group', m: C2cMsg | GroupMsg, c2c: C2cMsg[], group: GroupMsg[]): void {
  if (kind === 'c2c') c2c.push(m as C2cMsg);
  else group.push(m as GroupMsg);
}
