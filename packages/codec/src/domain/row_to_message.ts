/**
 * Convert one SQL row into a Domain `Message`.
 *
 * Pipeline:
 *   1. `row['40800']` (BLOB) → `ProtoMsg(MsgBody).decode(...)` → ElementWire[]
 *   2. Each ElementWire → `decodeElement(wire)` → high-level `Element`
 *   3. Combine with row-level metadata (senderUid, peerUid, …) into Message.
 *
 * `SqlRow` is intentionally untyped right now because the row column schemas
 * (40050, 40027, …) are still TODO RE. Tighten this type as those columns
 * are decoded.
 */

import { ProtoMsg } from '../core';
import { decodeElement } from '../element';
import { MsgBody } from '../proto/msg/40800';
import { sanitizeBytes } from '../raw';
import type { Element } from '../element';
import type { C2cMessage, GroupMessage } from './message';

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

export function rowToGroupMessage(row: SqlRow): GroupMessage {
  return {
    chatType: 'group',
    msgId: str(row, '40001'),
    msgSeq: str(row, '40003'),
    msgTime: str(row, '40050'),
    senderUid: str(row, '40020'),
    peerUid: str(row, '40021'),
    elements: decodeBody(row['40800']),
  };
}

export function rowToC2cMessage(row: SqlRow): C2cMessage {
  return {
    chatType: 'c2c',
    msgId: str(row, '40001'),
    msgSeq: str(row, '40003'),
    msgTime: str(row, '40050'),
    senderUid: str(row, '40020'),
    peerUid: str(row, '40021'),
    elements: decodeBody(row['40800']),
  };
}
