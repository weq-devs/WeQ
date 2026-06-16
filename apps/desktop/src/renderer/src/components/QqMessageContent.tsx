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
import { cn } from '@renderer/lib/utils';

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

export function QqMessageContent({ elements }: { elements: RenderElement[] }) {
  const meaningful = elements.filter(isMeaningful);
  const first = meaningful[0];
  const loneFace =
    meaningful.length === 1 && first?.type === 'face' ? first : null;

  if (loneFace) {
    const data = loneFace.data ?? {};
    // subType 1/2 → classic built-in face, render text-sized in the bubble;
    // every other face (super emoji, dice/rps, …) gets a borderless sticker box.
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

  const nodes: ReactNode[] = meaningful.map((element, index) => {
    const key = `el-${index}`;
    if (element.type === 'face') {
      return <FaceNode key={key} data={element.data ?? {}} size={INLINE_SIZE} />;
    }
    const text = inlineLabel(element);
    return text ? <span key={key}>{text}</span> : null;
  });

  return <div className={cn('message-content', 'qq-message-inline')}>{nodes}</div>;
}

/** MessageRenderer that handles messages carrying at least one face element. */
export const qqFaceMessageRenderer: MessageRenderer = {
  id: 'qq-face',
  match: ({ message }) => {
    const elements = (message as { qqElements?: RenderElement[] }).qqElements;
    return (
      Array.isArray(elements) && elements.some((element) => element?.type === 'face')
    );
  },
  render: ({ message }) => {
    const elements = (message as { qqElements?: RenderElement[] }).qqElements ?? [];
    return <QqMessageContent elements={elements} />;
  },
};
