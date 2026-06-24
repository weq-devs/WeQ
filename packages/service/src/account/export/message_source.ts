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
 * Yield every message of a group, oldest-first, paging under the hood.
 *
 * NOTE: the cursor uses `msgSeq > lastSeq`, which assumes per-group seqs are
 * unique (they are — 40003 is a per-group incrementing sequence). If a future
 * dataset proves otherwise, switch the cursor to a (seq,msgId) tuple.
 */
export async function* iterateGroupMessages(
  msgs: MsgService,
  groupCode: string,
  opts: IterateOptions = {},
): AsyncGenerator<RenderGroupMsg> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  let cursor = 0n;
  for (;;) {
    const page = await msgs.getGroupAfter(groupCode, cursor, pageSize);
    if (page.length === 0) break;
    for (const m of page) {
      if (withinRange(Number(m.sendTime), opts.range)) yield m;
    }
    const last = page[page.length - 1]!;
    cursor = last.msgSeq;
    // A short page means we reached the tail — no need for one more empty query.
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
  let cursor = 0n;
  for (;;) {
    const page = await msgs.getC2cAfter(peerUid, cursor, pageSize);
    if (page.length === 0) break;
    for (const m of page) {
      if (withinRange(Number(m.sendTime), opts.range)) yield m;
    }
    const last = page[page.length - 1]!;
    cursor = last.msgSeq;
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
