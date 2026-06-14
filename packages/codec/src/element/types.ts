/**
 * Element abstract model — Layer 2 of the codec stack.
 *
 * Types are now derived from Zod schemas in `spec.ts` for runtime validation.
 * The required-vs-optional distinction drives downstream UI choices.
 *
 * decode flow: ElementWire (raw protobuf) → decodeElement → adds `kind`
 * discriminator based on `wire.elementType` and forwards every other field
 * as-is. Nothing is dropped at the element layer; the renderer or msg
 * pipeline decides what to render or hide.
 *
 * encode flow: Element → encodeElement → strips `kind`, fills in
 * `elementType` from the kind→type map, forwards every other field as-is.
 *
 * Tag numbers (40010, 45001, 45002, …) are described in `../proto/msg/element.ts`.
 */

import type { ProtoEncodeStructType } from '../core';
import type { ElementWire } from '../proto/msg/element';

export type {
  TextElement,
  AtElement,
  PicElement,
  FileElement,
  PttElement,
  VideoElement,
  FaceElement,
  ReplyElement,
  GrayTipRevokeElement,
  GrayTipPokeElement,
  GrayTipGroupElement,
  WalletElement,
  ArkElement,
  MfaceElement,
  MarkdownElement,
  MultiMsgElement,
  CallElement,
  OnlineFileElement,
  OnlineFolderElement,
  EmojiBounceElement,
  QqDynamicElement,
  UnknownElement,
  Element,
} from './spec';

export enum ElementType {
  TEXT = 1,
  PIC = 2,
  FILE = 3,
  PTT = 4,
  VIDEO = 5,
  FACE = 6,
  REPLY = 7,
  GRAY_TIP = 8,
  WALLET = 9,
  ARK = 10,
  MFACE = 11,
  MARKDOWN = 14,
  MULTI_MSG = 16,
  CALL = 21,
  ONLINE_FILE = 23,
  QQ_DYNAMIC = 26,
  EMOJI_BOUNCE = 27,
  ONLINE_FOLDER = 30,
}

export enum PicSubType {
  NORMAL = 0,
  EMOJI = 1,
}

export enum PicType {
  NORMAL = 1000,
  EMOJI = 2000,
  ORIGINAL = 1001,
}

export enum PttType {
  INTERCOM = 1,
  RECORDING = 2,
}

export enum GrayTipSubType {
  REVOKE = 1,
  GROUP_TIP = 4,
  POKE = 17,
}

export enum CallSubType {
  VIDEO_ACCEPTED = 2,
  VIDEO_REJECTED_BY_US = 3,
  VIDEO_REJECTED_BY_PEER = 6,
  VOICE_ACCEPTED = 7,
  VOICE_REJECTED_BY_US = 8,
  VOICE_REJECTED_BY_PEER = 11,
  VIDEO_HANDLED_OTHER_DEVICE = 12,
  VOICE_HANDLED_OTHER_DEVICE = 13,
  SCREEN_SHARE_ACCEPTED = 19,
  SCREEN_SHARE_REJECTED = 22,
  REMOTE_ASSIST_ACCEPTED = 33,
  REMOTE_ASSIST_FAILED = 34,
}

export enum CallType {
  VOICE = 1,
  VIDEO = 2,
  SCREEN_SHARE = 3,
  REMOTE_ASSIST = 5,
}

export enum FaceSubType {
  QQ_BUILTIN_OLD = 1,
  QQ_BUILTIN_NEW = 2,
  SUPER_EMOJI = 3,
  UNKNOWN_4 = 4,
  INTERACTIVE = 5,
}

export enum ActionType {
  SYSTEM = 1,
}

// ─────────────────────────────────────────────────────────────────────────
// Downstream-parsing helper shapes (NOT part of the wire — these describe
// the structure of JSON/XML payloads carried INSIDE certain wire string
// fields like arkData, tipJson, grayTipXmlContent, xmlContent).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shape of the JSON document stored in wire field 47901 for ARK elements.
 */
export interface ArkPayload {
  app: string;
  desc: string;
  meta: Record<string, Record<string, unknown>>;
  prompt: string;
  sourceName?: string;
  ver?: string;
  view: string;
  config?: ArkConfig;
}

export interface ArkConfig {
  /** Unix seconds. */
  ctime: number;
  /** Card signature token. */
  token: string;
}

/**
 * Shape of the XML document stored in wire field 48602 for MULTI_MSG.
 */
export interface MultiMsgXmlPayload {
  serviceID: string;
  templateID: string;
  action: string;
  brief: string;
  m_resid: string;
  m_fileName: string;
  tSum: string;
  flag: string;
  item?: {
    layout: string;
    titles: Array<{ color: string; size: string; text: string }>;
    summary?: { color: string; text: string };
  };
  source?: { name: string };
}

/** Tip item in gray tip JSON (tag 48271). */
export interface TipJsonItem {
  type: 'img' | 'qq' | 'nor' | 'url' | string;
  src?: string;
  uid?: string;
  txt?: string;
  col?: string;
  jp?: string;
}

/** Shape of the JSON document in gray tip (tag 48271). */
export interface TipJsonPayload {
  items: TipJsonItem[];
}

/** Shape of the XML document in action gray tip (tag 48214). */
export interface ActionXmlPayload {
  align: string;
  elements: Array<{
    type: 'qq' | 'img' | 'nor';
    uin?: string;
    col?: string;
    nm?: string;
    tp?: string;
    src?: string;
    jp?: string;
    txt?: string;
  }>;
}
