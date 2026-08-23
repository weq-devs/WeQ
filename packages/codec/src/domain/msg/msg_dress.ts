/**
 * Decode the 40801 message-decoration column.
 *
 * The BLOB wraps a single MsgDressWire payload inside an outer tag-40801 field
 * (i.e. the full column bytes start with field key 40801). Only the three fields
 * confirmed from a full Android-library scan are surfaced in the public type;
 * the rest remain in the raw wire struct but are not exposed.
 */

import { ProtoMsg, type ProtoDecodeStructType } from '../../core';
import { MsgDressBody, type MsgDressWire } from '../../proto/msg/40801';
import { sanitizeBytes } from '../../raw';

export type MsgDressRecord = ProtoDecodeStructType<typeof MsgDressWire>;

const dressCodec = new ProtoMsg(MsgDressBody);

/**
 * Decoded per-message decoration data from column 40801.
 *
 * Only fields confirmed against real data are included; others remain opaque.
 */
export interface MsgDecoration {
  /** Bubble skin itemId. 0 = no bubble. */
  bubbleId: number;
  /** Chat-font skin itemId. 0 = no custom font. */
  fontId: number;
  /** Widget (挂件) itemId. 0 = no widget. */
  widgetId: number;
}

/** Decode the fallback font itemId stored in tag 41531 (byte-swapped uint16). */
function decodeFallbackFontId(stored: number | undefined): number {
  if (stored == null || stored === 0) return 0;
  return ((stored & 0xff) << 8) | ((stored >>> 8) & 0xff);
}

export function decodeMsgDressColumn(blob: unknown): MsgDecoration | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) return null;
  try {
    const outer = dressCodec.decode(sanitizeBytes(blob, MsgDressBody));
    const d = outer.dress;
    if (!d) return null;
    const bubbleId = d.bubbleId ?? 0;
    const fontId = d.fontId && d.fontId !== 0 ? d.fontId : decodeFallbackFontId(d.flag41531);
    const widgetId = d.widgetId ?? 0;
    if (bubbleId === 0 && fontId === 0 && widgetId === 0) return null;
    return { bubbleId, fontId, widgetId };
  } catch {
    return null;
  }
}
