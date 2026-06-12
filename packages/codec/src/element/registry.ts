/**
 * Element codec dispatch — thin adapter between wire and Element.
 *
 * Since element interface field names match the wire schema field names
 * exactly, decode/encode reduce to:
 *   decode: lookup kind from wire.elementType → spread wire fields + add kind
 *   encode: drop kind → spread element fields + reconstruct elementType
 *
 * Unknown elementType values wrap the raw wire in an UnknownElement so the
 * bytes survive a round-trip.
 */

import type { ProtoDecodeStructType, ProtoEncodeStructType } from '../core';
import { ElementWire } from '../proto/msg/common/element';
import {
  ElementType,
  type Element,
  type UnknownElement,
} from './types';

type KnownKind = Exclude<Element['kind'], 'unknown'>;

const KIND_TO_TYPE: Record<KnownKind, ElementType> = {
  text: ElementType.TEXT,
  pic: ElementType.PIC,
  file: ElementType.FILE,
  ptt: ElementType.PTT,
  video: ElementType.VIDEO,
  face: ElementType.FACE,
  reply: ElementType.REPLY,
  grayTip: ElementType.GRAY_TIP,
  ark: ElementType.ARK,
  mface: ElementType.MFACE,
  markdown: ElementType.MARKDOWN,
  multiMsg: ElementType.MULTI_MSG,
  call: ElementType.CALL,
  onlineFile: ElementType.ONLINE_FILE,
  onlineFolder: ElementType.ONLINE_FOLDER,
  emojiBounce: ElementType.EMOJI_BOUNCE,
  qqDynamic: ElementType.QQ_DYNAMIC,
};

const TYPE_TO_KIND: Partial<Record<ElementType, KnownKind>> = {
  [ElementType.TEXT]: 'text',
  [ElementType.PIC]: 'pic',
  [ElementType.FILE]: 'file',
  [ElementType.PTT]: 'ptt',
  [ElementType.VIDEO]: 'video',
  [ElementType.FACE]: 'face',
  [ElementType.REPLY]: 'reply',
  [ElementType.GRAY_TIP]: 'grayTip',
  [ElementType.ARK]: 'ark',
  [ElementType.MFACE]: 'mface',
  [ElementType.MARKDOWN]: 'markdown',
  [ElementType.MULTI_MSG]: 'multiMsg',
  [ElementType.CALL]: 'call',
  [ElementType.ONLINE_FILE]: 'onlineFile',
  [ElementType.ONLINE_FOLDER]: 'onlineFolder',
  [ElementType.EMOJI_BOUNCE]: 'emojiBounce',
  [ElementType.QQ_DYNAMIC]: 'qqDynamic',
};

export function decodeElement(wire: ProtoDecodeStructType<typeof ElementWire>): Element {
  const type = (wire.elementType ?? 0) as ElementType;
  const kind = TYPE_TO_KIND[type];
  if (!kind) return makeUnknown(wire, wire.elementType ?? 0);
  return { kind, ...wire } as Element;
}

export function encodeElement(el: Element): ProtoEncodeStructType<typeof ElementWire> {
  if (el.kind === 'unknown') return el.raw;
  const { kind, ...rest } = el;
  return {
    ...rest,
    elementType: KIND_TO_TYPE[kind as KnownKind],
  } as ProtoEncodeStructType<typeof ElementWire>;
}

function makeUnknown(
  wire: ProtoDecodeStructType<typeof ElementWire>,
  elementType: number,
): UnknownElement {
  return {
    kind: 'unknown',
    elementId: wire.elementId,
    isSender: wire.isSender,
    subType: wire.subType,
    elementType,
    raw: wire as ProtoEncodeStructType<typeof ElementWire>,
  };
}
