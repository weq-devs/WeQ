/**
 * Shared helpers for the message-table accessors (c2c / group).
 *
 * `decodeBody` turns a 40800 BLOB into `Element[]`; `toBigint` / `toStr`
 * coerce raw `SqlValue`s. Kept here so c2c.ts and group.ts don't duplicate
 * the codec wiring.
 */

import { ProtoMsg, decodeElement } from '@weq/codec';
import type { Element } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import type { SqlValue } from '@weq/native';

const bodyCodec = new ProtoMsg(MsgBody);

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

export function toBigint(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

export function toStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : String(v ?? '');
}
