/**
 * Expand a merged-forward (合并转发) placeholder into its real content.
 *
 * The forwarded messages are NOT in the carrying message's own body — QQ NT
 * stores only a `multiMsg` element there (a card: title + preview lines). The
 * actual forwarded messages live in the 40900 message-cache column as a full
 * recursive snapshot (see proto/msg/40900.ts). The live chat fetches this lazily
 * (`getForwardMessages`) when the user clicks 「查看详情」; the exporters never
 * did, so every export showed a bare `[合并转发]` label and lost the content.
 *
 * This module bridges that gap: given a message's 40900 cache records, it lifts
 * each into a {@link ForwardMessage} (render-view elements + sender/time), and
 * stamps them onto the message's `multiMsg` element(s) as `data.forwardMessages`
 * so every format renderer can inline the real messages. A nested forward
 * re-appears as a `multiMsg` element inside a lifted record's elements, carrying
 * its own `forwardMessages` — recursion is fully resolved here, in one pass over
 * the single 40900 blob (which already nests all levels), so no extra DB round
 * trips per depth.
 */

import { decodeElement, type MsgCacheRecord } from '@weq/codec';
import type { MsgService } from '../msg';
import { toRenderElements, type ForwardMessage, type RenderElement } from '../msg_view';
import type { ConvKind, ExportedMessage } from './types';

/** A raw 40900 record's fields we read (all optional on the wire). */
interface CacheRecordLike {
  senderUin?: number | bigint;
  senderUid?: string;
  sendTime?: number | bigint;
  sendNick?: string;
  senderInfo?: { avatar?: { encryptedUin?: string } };
  elements?: unknown[];
  subMsgs?: MsgCacheRecord[];
}

function num(v: number | bigint | undefined): number {
  return v == null ? 0 : Number(v);
}

/** A record's display name: nickname first, then uin, then uid, else '匿名'. */
function recordSenderName(rec: CacheRecordLike): string {
  const nick = (rec.sendNick ?? '').trim();
  if (nick) return nick;
  const uin = num(rec.senderUin);
  if (uin > 0) return String(uin);
  if (rec.senderUid) return rec.senderUid;
  return '匿名';
}

/** Lift one cache record's raw ElementWire[] into render-view elements. */
function recordElements(rec: CacheRecordLike): RenderElement[] {
  if (!Array.isArray(rec.elements)) return [];
  try {
    return toRenderElements(rec.elements.map((w) => decodeElement(w as never)));
  } catch {
    return [];
  }
}

/**
 * Recursively lift a list of 40900 cache records into {@link ForwardMessage}s.
 * A record that is itself a merged-forward carries its nested content under
 * `subMsgs`; we resolve those into the `forwardMessages` of the nested multiMsg
 * element so the tree renders to any depth. A depth guard stops a pathological
 * self-referential cache from looping forever.
 */
export function liftForwardRecords(records: MsgCacheRecord[], depth = 0): ForwardMessage[] {
  if (depth > 16 || !Array.isArray(records)) return [];
  const out: ForwardMessage[] = [];
  for (const raw of records) {
    const rec = raw as CacheRecordLike;
    const elements = recordElements(rec);
    // Attach any nested forward to the multiMsg element(s) in this record.
    const nested = Array.isArray(rec.subMsgs) ? rec.subMsgs : [];
    if (nested.length > 0) {
      const lifted = liftForwardRecords(nested, depth + 1);
      for (const el of elements) {
        if (el.type === 'multiMsg') el.data.forwardMessages = lifted;
      }
    }
    out.push({
      senderName: recordSenderName(rec),
      senderUin: num(rec.senderUin) > 0 ? String(num(rec.senderUin)) : '',
      sendTime: num(rec.sendTime),
      elements,
    });
  }
  return out;
}

/**
 * If `exported` carries any merged-forward element, fetch its 40900 cache once
 * and stamp the expanded messages onto every `multiMsg` element. No-op (and no
 * DB hit) for the overwhelming majority of messages that carry no forward.
 *
 * The 40900 blob for a MULTI_FORWARD row already nests every level, so one
 * lookup by the carrying msgId resolves the whole tree. Swallows lookup/decode
 * errors so a bad cache never breaks the export — the element just keeps its
 * `[合并转发]` placeholder.
 */
export async function expandForwards(
  msgs: MsgService,
  kind: ConvKind,
  exported: ExportedMessage,
): Promise<void> {
  const hasForward = exported.elements.some((el) => el.type === 'multiMsg');
  if (!hasForward) return;
  let records: MsgCacheRecord[];
  try {
    records = await msgs.listForward(kind, BigInt(exported.msgId));
  } catch {
    return;
  }
  if (records.length === 0) return;
  const lifted = liftForwardRecords(records);
  if (lifted.length === 0) return;
  for (const el of exported.elements) {
    if (el.type === 'multiMsg') el.data.forwardMessages = lifted;
  }
}
