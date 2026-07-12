/**
 * The reusable middle layer of the export pipeline: stream a whole
 * conversation's messages in chronological order, and normalize each one into
 * an {@link ExportedMessage}.
 *
 * Streaming (async generator) instead of "load all then return an array" is the
 * whole point — a busy group can hold hundreds of thousands of messages, and a
 * full in-memory array (plus its decoded protobuf elements) would blow the
 * heap. Callers `for await` one message at a time and write as they go.
 *
 * Paging strategy: ascending by msgSeq (40003) using a cursor, so each page hits
 * the `(40027,40003)` composite index and the output is naturally oldest-first
 * (the order a chat log reads top-to-bottom). The cursor advances to the last
 * seq of each page; we stop when a short page comes back.
 *
 * Mixed-seq conversations: phone→PC migrated history lands with no per-conv seq
 * (40003 = 0/NULL), so the seq cursor (`40003 > 0`) never returns it — yet the
 * PC's own messages (seq > 0) do, so a naive seq scan silently drops all the
 * imported history. To capture both, we run TWO cursors and merge them by
 * sendTime: the seq scan (seq > 0) and a rowid scan restricted to seq-less rows
 * (the imported block). Each stream is ~oldest-first on its own; the merge
 * interleaves them into one globally chronological stream. When a conversation
 * has no imported rows the seq-less stream is empty (one cheap query), and when
 * every row is seq-less the seq stream is empty — both degenerate cases fall out
 * of the same merge with no special-casing.
 */

import type { MsgService, RenderGroupMsg, RenderC2cMsg } from '../msg';
import type { ExportedMessage, ExportTimeRange } from './types';

export interface IterateOptions {
  /** Messages per DB round-trip. Larger = fewer queries, more peak memory. */
  pageSize?: number;
  /** Inclusive send-time window (unix seconds); out-of-range messages are skipped. */
  range?: ExportTimeRange;
}

const DEFAULT_PAGE_SIZE = 2000;

/**
 * Whether a message's send time falls inside `range`. No range (or both bounds
 * null) accepts everything — the common "全部时间" case pays no per-message cost
 * beyond this guard. Paging still walks by msgSeq; only what we *yield* is
 * filtered, so the seq cursor and short-page termination are unaffected.
 */
function withinRange(sendTimeSec: number, range?: ExportTimeRange): boolean {
  if (!range) return true;
  if (range.start != null && sendTimeSec < range.start) return false;
  if (range.end != null && sendTimeSec > range.end) return false;
  return true;
}

/**
 * Merge two ~oldest-first message streams into one, ordered by sendTime. Both
 * inputs are individually near-ascending on sendTime (a seq scan and a rowid
 * scan of an imported block), so a classic two-way merge yields a globally
 * chronological stream while only ever holding one message from each in memory.
 * Ties and small local disorder inside a stream are preserved as-is — that's
 * the best obtainable order without a usable seq on the imported rows.
 */
async function* mergeBySendTime<T extends { sendTime: bigint }>(
  a: AsyncGenerator<T>,
  b: AsyncGenerator<T>,
): AsyncGenerator<T> {
  let na = await a.next();
  let nb = await b.next();
  while (!na.done && !nb.done) {
    if (na.value.sendTime <= nb.value.sendTime) {
      yield na.value;
      na = await a.next();
    } else {
      yield nb.value;
      nb = await b.next();
    }
  }
  for (; !na.done; na = await a.next()) yield na.value;
  for (; !nb.done; nb = await b.next()) yield nb.value;
}

/**
 * Yield every message of a group, oldest-first, paging under the hood.
 *
 * NOTE: the seq cursor uses `msgSeq > lastSeq`, which assumes per-group seqs are
 * unique (they are — 40003 is a per-group incrementing sequence). If a future
 * dataset proves otherwise, switch the cursor to a (seq,msgId) tuple.
 */
export async function* iterateGroupMessages(
  msgs: MsgService,
  groupCode: string,
  opts: IterateOptions = {},
): AsyncGenerator<RenderGroupMsg> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const merged = mergeBySendTime(
    pageGroupBySeq(msgs, groupCode, pageSize),
    pageGroupBySeqlessRowId(msgs, groupCode, pageSize),
  );
  for await (const m of merged) {
    if (withinRange(Number(m.sendTime), opts.range)) yield m;
  }
}

/** Group seq cursor (`40003 > lastSeq`): all messages that carry a real seq. */
async function* pageGroupBySeq(
  msgs: MsgService,
  groupCode: string,
  pageSize: number,
): AsyncGenerator<RenderGroupMsg> {
  let cursor = 0n;
  for (;;) {
    const page = await msgs.getGroupAfter(groupCode, cursor, pageSize);
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.msgSeq;
    // A short page means we reached the tail — no need for one more empty query.
    if (page.length < pageSize) break;
  }
}

/** Group rowid cursor over seq-less rows only: the migration-imported block. */
async function* pageGroupBySeqlessRowId(
  msgs: MsgService,
  groupCode: string,
  pageSize: number,
): AsyncGenerator<RenderGroupMsg> {
  let cursor = 0n;
  for (;;) {
    const page = await msgs.getGroupSeqlessAfterRowId(groupCode, cursor, pageSize);
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.rowId;
    if (page.length < pageSize) break;
  }
}

/**
 * Yield every c2c message with a peer, oldest-first, paging under the hood.
 */
export async function* iterateC2cMessages(
  msgs: MsgService,
  peerUid: string,
  opts: IterateOptions = {},
): AsyncGenerator<RenderC2cMsg> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const merged = mergeBySendTime(
    pageC2cBySeq(msgs, peerUid, pageSize),
    pageC2cBySeqlessRowId(msgs, peerUid, pageSize),
  );
  for await (const m of merged) {
    if (withinRange(Number(m.sendTime), opts.range)) yield m;
  }
}

/** C2c seq cursor (`40003 > lastSeq`): all messages that carry a real seq. */
async function* pageC2cBySeq(
  msgs: MsgService,
  peerUid: string,
  pageSize: number,
): AsyncGenerator<RenderC2cMsg> {
  let cursor = 0n;
  for (;;) {
    const page = await msgs.getC2cAfter(peerUid, cursor, pageSize);
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.msgSeq;
    if (page.length < pageSize) break;
  }
}

/** C2c rowid cursor over seq-less rows only: the migration-imported block. */
async function* pageC2cBySeqlessRowId(
  msgs: MsgService,
  peerUid: string,
  pageSize: number,
): AsyncGenerator<RenderC2cMsg> {
  let cursor = 0n;
  for (;;) {
    const page = await msgs.getC2cSeqlessAfterRowId(peerUid, cursor, pageSize);
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.rowId;
    if (page.length < pageSize) break;
  }
}

/** Normalize a render message into the export record (bigints → strings). */
export function toExportedMessage(m: RenderGroupMsg | RenderC2cMsg): ExportedMessage {
  return {
    msgId: m.msgId.toString(),
    msgSeq: m.msgSeq.toString(),
    sendTime: Number(m.sendTime),
    senderUin: m.senderUin.toString(),
    senderUid: m.senderUid,
    elements: m.elements,
  };
}
