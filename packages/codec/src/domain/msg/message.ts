/**
 * Domain message model — Layer 3 of the codec stack.
 *
 * A Message is what the renderer ultimately consumes: a list of Elements
 * plus the row-level metadata (who, when, where) needed to display them.
 *
 * Per-chat-type extensions live here because group vs. c2c differ in
 * sender/peer semantics. Both share the BaseMessage core. The discriminated
 * union is keyed on `kind` ('group' | 'c2c'); the separate `chatType` field
 * carries the mapped value of SQL column 40010 (full ChatType, not just the
 * coarse group/c2c split — e.g. temp sessions).
 *
 * Mapped fields (`chatType`/`msgType`/`sendType`/`sendStatus`) return the enum
 * MEMBER NAME (string) when the raw value is in range, or the raw number when
 * it isn't. `subMsgType` is always the raw number.
 */

import type { Element } from '../../element';

/** Enum-mapped column: member name when in range, raw number otherwise. */
export type MappedEnum = string | number;

export interface BaseMessage {
  msgId: string;
  msgSeq: string;
  msgTime: string;
  senderUid: string;
  peerUid: string;
  /** SQL column 40010 — mapped ChatType. */
  chatType: MappedEnum;
  /** SQL column 40011 — mapped MsgType (8=MULTI_FORWARD, 9=REPLY). */
  msgType: MappedEnum;
  /** SQL column 40012 — raw sub-type, unmapped. */
  subMsgType: number;
  /** SQL column 40013 — mapped SendType (origin: local/other-client/forward/…). */
  sendType: MappedEnum;
  /** SQL column 40041 — mapped SendStatus (success/blocked/banned/…). */
  sendStatus: MappedEnum;
  elements: Element[];
}

export interface SetEmojiItem {
  emojiId: string;
  setNum: number;
  isSelfSet: boolean;
}

export interface GroupMessage extends BaseMessage {
  kind: 'group';
  setEmojiList?: SetEmojiItem[];
  /** TODO(RE): sender display name, role, anonymous info, … */
}

export interface C2cMessage extends BaseMessage {
  kind: 'c2c';
  /** TODO(RE): c2c-specific routing fields */
}

export type Message = GroupMessage | C2cMessage;
