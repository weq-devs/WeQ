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

import { createContext, useContext, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import type { MessageRenderer } from '../im-template/template';
import { FaceEmoji } from './FaceEmoji';
import { QqImage, QqVideo, QqFile, QqVoice, QqMarketFace } from './QqMedia';
import { cn } from '@renderer/lib/utils';

/**
 * Lets a reply quote ask the host (MainView) to scroll the message list to the
 * referenced message. Both seq candidates are passed because the column that
 * matches `40003` differs by conversation kind — group uses origMsgSeq(47402),
 * c2c uses origMsgIndex(47419) — and only the host knows the current kind.
 * Default is a no-op so the renderer also works when mounted outside a provider
 * (e.g. tests).
 */
export interface ReplyJumpTarget {
  /** origMsgSeq (tag 47402) — the 40003 anchor for GROUP messages. */
  seq?: number | string;
  /** origMsgIndex (tag 47419) — the 40003 anchor for C2C messages. */
  index?: number | string;
}
export const ReplyJumpContext = createContext<(target: ReplyJumpTarget) => void>(() => {});

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
  subType?: number;
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
    subType: typeof data.subType === 'number' ? data.subType : Number(data.subType) || undefined,
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
  msgId,
}: {
  element: RenderElement;
  sendTimeMs: number;
  msgId: string;
}): ReactNode {
  const data = element.data ?? {};
  switch (element.type) {
    case 'pic':
      return <QqImage data={data} sendTimeMs={sendTimeMs} />;
    case 'video':
      return <QqVideo data={data} sendTimeMs={sendTimeMs} />;
    case 'file':
      return <QqFile data={data} sendTimeMs={sendTimeMs} msgId={msgId} />;
    case 'ptt':
      return <QqVoice data={data} sendTimeMs={sendTimeMs} />;
    case 'mface':
      return <QqMarketFace data={data} />;
    default:
      return null;
  }
}

/** Render one element inline (media component, face, @-mention or text). */
function ElementNode({
  element,
  sendTimeMs,
  msgId,
}: {
  element: RenderElement;
  sendTimeMs: number;
  msgId: string;
}): ReactNode {
  if (element.type && MEDIA_KINDS.has(element.type)) {
    return <MediaNode element={element} sendTimeMs={sendTimeMs} msgId={msgId} />;
  }
  if (element.type === 'face') {
    return <FaceNode data={element.data ?? {}} size={INLINE_SIZE} />;
  }
  if (element.type === 'at') {
    const text = String(element.data?.textContent ?? '');
    return (
      <span
        className="qq-at-element text-blue-500 font-medium cursor-pointer hover:underline"
        title={`UID: ${element.data?.buddleId || 'unknown'}`}
      >
        {text}
      </span>
    );
  }
  const text = inlineLabel(element);
  return text ? <span>{text}</span> : null;
}

/** Compact one-line label for a quoted element (media → bracket tag). */
const REPLY_MEDIA_LABEL: Record<string, string> = {
  pic: '[图片]',
  video: '[视频]',
  file: '[文件]',
  ptt: '[语音]',
  mface: '[动画表情]',
};

/** Render a quoted element compactly: text/@/face inline, media as a tag. */
function ReplyPreviewNode({ element }: { element: RenderElement }): ReactNode {
  if (element.type === 'face') {
    return <FaceNode data={element.data ?? {}} size="1.2em" />;
  }
  if (element.type && REPLY_MEDIA_LABEL[element.type]) {
    const name = inlineLabel(element);
    const label = REPLY_MEDIA_LABEL[element.type];
    return <span>{name && element.type === 'file' ? `${label} ${name}` : label}</span>;
  }
  const text = inlineLabel(element);
  return <span>{text || '引用消息'}</span>;
}

/**
 * The darker quote box for a `reply` element: shows the referenced message's
 * last element with an up-arrow that scrolls to that message's seq.
 */
function ReplyQuote({ data }: { data: Record<string, unknown> }) {
  const jumpToSeq = useContext(ReplyJumpContext);
  const origElements = Array.isArray(data.origElements) ? (data.origElements as RenderElement[]) : [];
  const meaningful = origElements.filter(isMeaningful);
  const preview = meaningful.length > 0 ? meaningful[meaningful.length - 1] : null;
  // Pass both 40003 candidates; the host picks by conversation kind. Verified
  // against the live DB: group → origMsgSeq(47402), c2c → origMsgIndex(47419).
  const seq = data.origMsgSeq as number | string | undefined;
  const index = data.origMsgIndex as number | string | undefined;
  const isUsable = (v: unknown): boolean =>
    typeof v === 'number' || (typeof v === 'string' && v.length > 0);
  const canJump = isUsable(seq) || isUsable(index);

  function handleJump(event: ReactMouseEvent | ReactKeyboardEvent): void {
    event.stopPropagation();
    if (canJump) jumpToSeq({ seq, index });
  }

  return (
    <div
      className="qq-reply-quote"
      role={canJump ? 'button' : undefined}
      tabIndex={canJump ? 0 : undefined}
      title={canJump ? '跳转到原消息' : undefined}
      onClick={canJump ? handleJump : undefined}
      onKeyDown={(event) => {
        if (canJump && (event.key === 'Enter' || event.key === ' ')) handleJump(event);
      }}
    >
      <div className="qq-reply-quote-body">
        {preview ? <ReplyPreviewNode element={preview} /> : <span>引用消息</span>}
      </div>
      {canJump ? <ArrowUp className="qq-reply-quote-arrow" size={14} strokeWidth={2.4} aria-hidden /> : null}
    </div>
  );
}

export function QqMessageContent({
  elements,
  sendTimeMs,
  msgId,
}: {
  elements: RenderElement[];
  sendTimeMs: number;
  msgId: string;
}) {
  // A `reply` element renders as a quote box above the body; pull it out so the
  // body sizing rules below only consider the actual message content.
  const replyElement = elements.find((element) => element.type === 'reply');
  const bodyElements = replyElement ? elements.filter((element) => element.type !== 'reply') : elements;
  const meaningful = bodyElements.filter(isMeaningful);
  const first = meaningful[0];
  const lone = !replyElement && meaningful.length === 1 ? first : null;

  if (replyElement) {
    return (
      <div className={cn('message-content', 'qq-message-inline', 'qq-has-reply')}>
        <ReplyQuote data={replyElement.data ?? {}} />
        {meaningful.length > 0 ? (
          <div className="qq-reply-body">
            {meaningful.map((element, index) => (
              <ElementNode key={`el-${index}`} element={element} sendTimeMs={sendTimeMs} msgId={msgId} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (lone) {
    // A lone borderless media element (image/video/sticker/mface) renders with
    // no bubble background — same treatment as a sticker face.
    if (lone.type && BORDERLESS_MEDIA.has(lone.type)) {
      return (
        <div className={cn('message-content', 'sticker-only')}>
          <MediaNode element={lone} sendTimeMs={sendTimeMs} msgId={msgId} />
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
          <MediaNode element={lone} sendTimeMs={sendTimeMs} msgId={msgId} />
        </div>
      );
    }
  }

  const nodes: ReactNode[] = meaningful.map((element, index) => (
    <ElementNode key={`el-${index}`} element={element} sendTimeMs={sendTimeMs} msgId={msgId} />
  ));

  return <div className={cn('message-content', 'qq-message-inline')}>{nodes}</div>;
}

/** Element kinds this renderer claims (reply/face/at + rich media). */
const HANDLED_KINDS = new Set(['reply', 'face', 'at', 'pic', 'video', 'file', 'ptt', 'mface']);

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
    const m = message as { qqElements?: RenderElement[]; createdAt?: string; msgId?: string };
    const elements = m.qqElements ?? [];
    const sendTimeMs = m.createdAt ? Date.parse(m.createdAt) : 0;
    const msgId = m.msgId ?? '';
    return <QqMessageContent elements={elements} sendTimeMs={sendTimeMs} msgId={msgId} />;
  },
};
