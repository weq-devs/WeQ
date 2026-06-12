/**
 * Decode the 40900 message-cache column.
 *
 * The 40900 BLOB is a REPEATED MsgCache (see proto/msg/40900.ts). This mirrors
 * `decodeBody` for the 40800 column: sanitize conflicting wire types, decode,
 * and hand back the raw MsgCache records. Each record may itself nest a 40900
 * list (forward / reply cache) — that recursion is preserved as-is.
 */

import { ProtoMsg, type ProtoDecodeStructType } from '../../core';
import { MsgCache, MsgCacheBody } from '../../proto/msg/40900';
import { sanitizeBytes } from '../../raw';

/** One decoded 40900 entry (full message snapshot). */
export type MsgCacheRecord = ProtoDecodeStructType<typeof MsgCache>;

const cacheCodec = new ProtoMsg(MsgCacheBody);

export function decodeMsgCacheColumn(blob: unknown): MsgCacheRecord[] {
  if (!(blob instanceof Uint8Array)) return [];
  try {
    const decoded = cacheCodec.decode(sanitizeBytes(blob, MsgCacheBody));
    return (decoded.msgs ?? []) as MsgCacheRecord[];
  } catch {
    return [];
  }
}
