/**
 * Convert one SQL row into a Domain `Message`.
 *
 * Pipeline:
 *   1. `row['40800']` (BLOB) → `ProtoMsg(MsgBody).decode(...)` → ElementWire[]
 *   2. Each ElementWire → `decodeElement(wire)` → high-level `Element`
 *   3. Combine with row-level metadata (senderUid, peerUid, …) into Message.
 *
 * Enum columns (40010/40011/40013/40041) are run through `enumName`, which
 * returns the enum member name when the value is in range and the raw number
 * otherwise. Column 40012 (subMsgType) is forwarded raw.
 *
 * `SqlRow` is intentionally untyped right now because the row column schemas
 * are still TODO RE. Tighten this type as those columns are decoded.
 */

import { ProtoMsg } from '../../core';
import { decodeElement } from '../../element';
import { MsgBody } from '../../proto/msg/40800';
import { MsgType, SendType, SendStatus } from '../../proto/msg/40900';
import { sanitizeBytes } from '../../raw';
import type { Element } from '../../element';
import type { BaseMessage, C2cMessage, GroupMessage } from './message';
import { ChatType, enumName } from './enums';

export type SqlRow = Record<string, unknown>;

const bodyCodec = new ProtoMsg(MsgBody);

function decodeBody(blob: unknown): Element[] {
  if (!(blob instanceof Uint8Array)) return [];
  // Drop fields whose on-wire type conflicts with the schema before handing
  // the bytes to protobuf-ts; otherwise one mis-declared tag derails the whole
  // message. Conflicting fields just go missing instead of crashing the decode.
  let decoded;
  try {
    decoded = bodyCodec.decode(sanitizeBytes(blob, MsgBody));
  } catch {
    return [];
  }
  return (decoded.elements ?? []).map(decodeElement);
}

function str(row: SqlRow, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : String(v ?? '');
}

function num(row: SqlRow, key: string): number {
  const v = row[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Shared column extraction for both chat types. */
function baseFields(row: SqlRow): Omit<BaseMessage, never> {
  return {
    msgId: str(row, '40001'),
    msgSeq: str(row, '40003'),
    msgTime: str(row, '40050'),
    senderUid: str(row, '40020'),
    peerUid: str(row, '40021'),
    chatType: enumName(ChatType, num(row, '40010')),
    msgType: enumName(MsgType, num(row, '40011')),
    subMsgType: num(row, '40012'),
    sendType: enumName(SendType, num(row, '40013')),
    sendStatus: enumName(SendStatus, num(row, '40041')),
    elements: decodeBody(row['40800']),
  };
}

export function rowToGroupMessage(row: SqlRow): GroupMessage {
  return { kind: 'group', ...baseFields(row) };
}

export function rowToC2cMessage(row: SqlRow): C2cMessage {
  return { kind: 'c2c', ...baseFields(row) };
}
