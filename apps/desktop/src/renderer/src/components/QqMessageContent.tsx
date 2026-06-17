/**
 * Renders a QQ message's elements as React nodes, upgrading `face` elements to
 * <FaceEmoji>. Plugs into the im-template via a MessageRenderer that only
 * matches messages containing at least one face — every other message keeps
 * the template's default (string/markdown) rendering untouched.
 *
 * Sizing rules:
 *   - Face mixed with other elements → text-sized, inline with the text.
 *   - A lone face:
 *       · classic small yellow face (source 小黄脸表情) → text-sized, in bubble.
 *       · anything else (super emoji, dice, …) → larger square sticker box,
 *         no bubble background/border.
 *
 * The raw render-view elements are stashed on the template message under
 * `qqElements` (see MainView.messageToTemplate).
 */

import type { ReactNode } from 'react';
import type { MessageRenderer } from '../im-template/template';
import { FaceEmoji } from './FaceEmoji';
import { QqImage, QqVideo, QqFile, QqVoice, QqMarketFace } from './QqMedia';
import { cn } from '@renderer/lib/utils';

/** Element kinds that render as standalone, borderless media (no bubble). */
const BORDERLESS_MEDIA = new Set(['pic', 'video', 'mface']);
/** Element kinds handled by a dedicated media component. */
const MEDIA_KINDS = new Set(['pic', 'video', 'file', 'ptt', 'mface']);

/** Box size for a lone sticker face (FaceSubType !== 1). */
const STICKER_SIZE = 90;
/** Inline face size, tracking the surrounding text. */
const INLINE_SIZE = '1.8em';

/** FaceSubType values that render inline (QQ_BUILTIN_OLD=1, QQ_BUILTIN_NEW=2). */
const FACE_SUBTYPE_INLINE = new Set([1, 2]);

type FaceData = {
  faceId: number;
  faceText?: string;
  diceValue?: string;
};

type RenderElement = {
  type?: string;
  data?: Record<string, unknown>;
};

function isMeaningful(element: RenderElement): boolean {
  if (element.type === 'text') {
    return String(element.data?.textContent ?? '').length > 0;
  }
  return true;
}

/** A face renders inline (text-sized) when its subType is 1 or 2. */
function isInlineFace(data: Record<string, unknown> = {}): boolean {
  return FACE_SUBTYPE_INLINE.has(Number(data.subType));
}

function faceProps(data: Record<string, unknown> = {}): FaceData {
  return {
    faceId: Number(data.faceId),
    faceText: typeof data.faceText === 'string' ? data.faceText : undefined,
    diceValue: typeof data.diceValue === 'string' ? data.diceValue : undefined,
  };
}

/** Best-effort inline text for a non-face element (matches the flattened body). */
function inlineLabel(element: RenderElement): string {
  const data = element.data ?? {};
  const text = data.textContent;
  if (typeof text === 'string' && text.length > 0) return text;
  const fileName = data.fileName;
  if (typeof fileName === 'string' && fileName.length > 0) return fileName;
  return '';
}

function FaceNode({
  data,
  size,
  animated,
}: {
  data: Record<string, unknown>;
  size: number | string;
  animated?: boolean;
}) {
  return <FaceEmoji element={faceProps(data)} size={size} animated={animated} />;
}

/** Render a media element to its dedicated component, or null if unsupported. */
function MediaNode({
  element,
  sendTimeMs,
}: {
  element: RenderElement;
  sendTimeMs: number;
}): ReactNode {
  const data = element.data ?? {};
  switch (element.type) {
    case 'pic':
      return <QqImage data={data} sendTimeMs={sendTimeMs} />;
    case 'video':
      return <QqVideo data={data} sendTimeMs={sendTimeMs} />;
    case 'file':
      return <QqFile data={data} sendTimeMs={sendTimeMs} />;
    case 'ptt':
      return <QqVoice data={data} sendTimeMs={sendTimeMs} />;
    case 'mface':
      return <QqMarketFace data={data} />;
    default:
      return null;
  }
}

export function QqMessageContent({
  elements,
  sendTimeMs,
}: {
  elements: RenderElement[];
  sendTimeMs: number;
}) {
  const meaningful = elements.filter(isMeaningful);
  const first = meaningful[0];
  const lone = meaningful.length === 1 ? first : null;

  if (lone) {
    // A lone borderless media element (image/video/sticker/mface) renders with
    // no bubble background — same treatment as a sticker face.
    if (lone.type && BORDERLESS_MEDIA.has(lone.type)) {
      return (
        <div className={cn('message-content', 'sticker-only')}>
          <MediaNode element={lone} sendTimeMs={sendTimeMs} />
        </div>
      );
    }
    if (lone.type === 'face') {
      const data = lone.data ?? {};
      if (isInlineFace(data)) {
        return (
          <div className={cn('message-content', 'qq-message-inline')}>
            <FaceNode data={data} size={INLINE_SIZE} />
          </div>
        );
      }
      return (
        <div className={cn('message-content', 'sticker-only')}>
          <FaceNode data={data} size={STICKER_SIZE} animated />
        </div>
      );
    }
    // Lone file/voice still sit in a normal bubble (cards, not stickers).
    if (lone.type && MEDIA_KINDS.has(lone.type)) {
      return (
        <div className={cn('message-content', 'qq-message-inline')}>
          <MediaNode element={lone} sendTimeMs={sendTimeMs} />
        </div>
      );
    }
  }

  const nodes: ReactNode[] = meaningful.map((element, index) => {
    const key = `el-${index}`;
    if (element.type && MEDIA_KINDS.has(element.type)) {
      return <MediaNode key={key} element={element} sendTimeMs={sendTimeMs} />;
    }
    if (element.type === 'face') {
      return <FaceNode key={key} data={element.data ?? {}} size={INLINE_SIZE} />;
    }
    if (element.type === 'at') {
      const text = String(element.data?.textContent ?? '');
      return (
        <span
          key={key}
          className="qq-at-element text-blue-500 font-medium cursor-pointer hover:underline"
          title={`UID: ${element.data?.buddleId || 'unknown'}`}
        >
          {text}
        </span>
      );
    }
    const text = inlineLabel(element);
    return text ? <span key={key}>{text}</span> : null;
  });

  return <div className={cn('message-content', 'qq-message-inline')}>{nodes}</div>;
}

/** Element kinds this renderer claims (face/at + rich media). */
const HANDLED_KINDS = new Set(['face', 'at', 'pic', 'video', 'file', 'ptt', 'mface']);

/** MessageRenderer that handles messages carrying face/at or rich-media elements. */
export const qqMessageRenderer: MessageRenderer = {
  id: 'qq-elements',
  match: ({ message }) => {
    const elements = (message as { qqElements?: RenderElement[] }).qqElements;
    return (
      Array.isArray(elements) &&
      elements.some((element) => element?.type !== undefined && HANDLED_KINDS.has(element.type))
    );
  },
  render: ({ message }) => {
    const m = message as { qqElements?: RenderElement[]; createdAt?: string };
    const elements = m.qqElements ?? [];
    const sendTimeMs = m.createdAt ? Date.parse(m.createdAt) : 0;
    return <QqMessageContent elements={elements} sendTimeMs={sendTimeMs} />;
  },
};
