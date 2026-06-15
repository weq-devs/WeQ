/**
 * Shared helpers for the message-table accessors (c2c / group).
 *
 * `decodeBody` turns a 40800 BLOB into `Element[]`; `toBigint` / `toStr`
 * coerce raw `SqlValue`s. Kept here so c2c.ts and group.ts don't duplicate
 * the codec wiring.
 */

import { ProtoMsg, decodeElement } from '@weq/codec';
import type { Element, SetEmojiItem } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { MsgEmoji } from '@weq/codec/proto/msg/40062';
import type { SqlValue } from '@weq/native';

const bodyCodec = new ProtoMsg(MsgBody);
const emojiCodec = new ProtoMsg(MsgEmoji);

export function decodeBody(blob: SqlValue | undefined): Element[] {
  if (!(blob instanceof Uint8Array)) return [];
  try {
    // Sanitize first: drop fields whose on-wire type conflicts with the schema
    // so one mis-declared tag can't derail the whole message.
    const decoded = bodyCodec.decode(sanitizeBytes(blob, MsgBody));
    return (decoded.elements ?? []).map(decodeElement);
  } catch (e) {
    console.error('[msg] failed to decode 40800 body:', e);
    return [{ kind: 'text', textContent: '[解析消息失败: 格式错误]' }];
  }
}

/**
 * Decode the 40062 BLOB (group message "贴表情"/sticker reactions). The column
 * is a protobuf whose only field is a repeated tag-40062 entry, one per emoji
 * reaction. Returns `undefined` when the column is empty/absent so the field is
 * simply omitted from the message.
 */
export function decodeEmoji(blob: SqlValue | undefined): SetEmojiItem[] | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  try {
    const decoded = emojiCodec.decode(sanitizeBytes(blob, MsgEmoji));
    const list = (decoded.stickers ?? []).map((s) => ({
      emojiId: s.emojiId ?? '',
      setNum: s.emojiNum ?? 0,
      isSelfSet: !!s.isSelfSet,
    }));
    return list.length > 0 ? list : undefined;
  } catch (e) {
    console.error('[msg] failed to decode 40062 emoji:', e);
    return undefined;
  }
}

export function toBigint(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

export function toStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : String(v ?? '');
}
