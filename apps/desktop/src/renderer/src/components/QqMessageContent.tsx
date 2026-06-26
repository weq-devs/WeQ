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
import { QqImage, QqVideo, QqFile, QqVoice, QqMarketFace, QqOnlineFile } from './QqMedia';
import { ForwardMultiMsgPreview } from './ForwardWindow';
import { QqArk } from './QqArk';
import { QqFlashTransfer } from './QqFlashTransfer';
import { QqWallet } from './QqWallet';
import { QqCall } from './QqCall';
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

/**
 * The conversation kind of the open chat. MultiMsg lookups (合并转发) hit a
 * different DB table for c2c vs group, so the preview bubble needs the host
 * to tell it which side to query. Defaults to 'c2c' for safety in tests.
 */
export const ForwardKindContext = createContext<'c2c' | 'group'>('c2c');

/**
 * Group code (群号) of the open chat, or '' for c2c. Video / file OIDB
 * completion needs the group id to resolve a group download URL; the host
 * provides it via this context so we don't thread it through every render
 * layer. Empty string ⇒ private (c2c).
 */
export const ConvContext = createContext<string>('');

/** Element kinds that render as standalone, borderless media (no bubble). */
const BORDERLESS_MEDIA = new Set(['pic', 'video', 'mface']);
/** Element kinds handled by a dedicated media component. */
const MEDIA_KINDS = new Set(['pic', 'video', 'file', 'ptt', 'mface', 'onlineFile', 'onlineFolder']);

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

/**
 * A `markdown` element is a QQ 闪传 (flash transfer) card iff it carries a
 * non-empty `flashTransferInfo` object. Returns that info (for the card) or null
 * (plain markdown → falls through to the template's default markdown renderer).
 */
function flashTransferInfoOf(element: RenderElement): Record<string, unknown> | null {
  if (element.type !== 'markdown') return null;
  const info = element.data?.flashTransferInfo;
  if (info && typeof info === 'object' && Object.keys(info as object).length > 0) {
    return info as Record<string, unknown>;
  }
  return null;
}

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
  isSender = true,
}: {
  data: Record<string, unknown>;
  size: number | string;
  animated?: boolean;
  isSender?: boolean;
}) {
  return <FaceEmoji element={faceProps(data)} size={size} animated={animated} isSender={isSender} />;
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
  const conv = useContext(ConvContext);
  switch (element.type) {
    case 'pic':
      return <QqImage data={data} sendTimeMs={sendTimeMs} />;
    case 'video':
      return <QqVideo data={data} sendTimeMs={sendTimeMs} msgId={msgId} conv={conv} />;
    case 'file':
      return <QqFile data={data} sendTimeMs={sendTimeMs} msgId={msgId} conv={conv} />;
    case 'ptt':
      return <QqVoice data={data} sendTimeMs={sendTimeMs} />;
    case 'mface':
      return <QqMarketFace data={data} />;
    case 'onlineFile':
      return <QqOnlineFile data={data} kind="file" />;
    case 'onlineFolder':
      return <QqOnlineFile data={data} kind="folder" />;
    default:
      return null;
  }
}

/**
 * Element kinds that behave as inline text — face, @-mention and plain text.
 * Consecutive elements of these kinds are coalesced into a single text-run
 * `<span>` so they share one inline flow (wrapping, baseline alignment,
 * `pre-wrap` line breaks) instead of being N independent siblings.
 */
const TEXT_LIKE_KINDS = new Set(['text', 'at', 'face']);

function isTextLike(element: RenderElement): boolean {
  return typeof element.type === 'string' && TEXT_LIKE_KINDS.has(element.type);
}

/** Render one element inline (media component, face, @-mention or text). */
function ElementNode({
  element,
  sendTimeMs,
  msgId,
  isSender = true,
}: {
  element: RenderElement;
  sendTimeMs: number;
  msgId: string;
  isSender?: boolean;
}): ReactNode {
  if (element.type && MEDIA_KINDS.has(element.type)) {
    return <MediaNode element={element} sendTimeMs={sendTimeMs} msgId={msgId} />;
  }
  if (element.type === 'face') {
    return <FaceNode data={element.data ?? {}} size={INLINE_SIZE} isSender={isSender} />;
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
  if (element.type === 'call') {
    const data = element.data ?? {};
    return (
      <QqCall
        callMethod={data.callMethod}
        subType={data.subType}
        callSummary={data.callSummary}
      />
    );
  }
  const text = inlineLabel(element);
  return text ? <span>{text}</span> : null;
}

/**
 * Render a list of elements, coalescing every run of text-like elements
 * (text / at / face) into a single inline `<span class="qq-text-run">` so they
 * share one inline flow. Non-text-like elements (images, files, cards, …)
 * stay as their own siblings.
 */
function renderElementNodes(
  elements: RenderElement[],
  sendTimeMs: number,
  msgId: string,
  isSender = true,
): ReactNode[] {
  const out: ReactNode[] = [];
  let runStart = -1;
  let runItems: RenderElement[] = [];

  const flushRun = () => {
    if (runItems.length === 0) return;
    const items = runItems;
    const start = runStart;
    out.push(
      <span key={`run-${start}`} className="qq-text-run">
        {items.map((el, i) => (
          <ElementNode key={`el-${start + i}`} element={el} sendTimeMs={sendTimeMs} msgId={msgId} isSender={isSender} />
        ))}
      </span>,
    );
    runItems = [];
    runStart = -1;
  };

  elements.forEach((element, index) => {
    if (isTextLike(element)) {
      if (runStart === -1) runStart = index;
      runItems.push(element);
      return;
    }
    flushRun();
    out.push(
      <ElementNode key={`el-${index}`} element={element} sendTimeMs={sendTimeMs} msgId={msgId} isSender={isSender} />,
    );
  });
  flushRun();
  return out;
}

/** Bracket-tag fallback for a quoted element when no thumbnail is available. */
const REPLY_MEDIA_LABEL: Record<string, string> = {
  pic: '[图片]',
  video: '[视频]',
  file: '[文件]',
  ptt: '[语音]',
  mface: '[动画表情]',
  onlineFile: '[在线文件]',
  onlineFolder: '[在线文件夹]',
};

/** Resolve the wall-clock time the quoted message was sent. The reply element
 * carries `origMsgTime` in seconds (QQ NT proto); fall back to the host
 * message's send time so animated emoji / image URLs can still time-stamp the
 * media protocol request. Returns 0 when neither is usable. */
function quoteSendTimeMs(replyData: Record<string, unknown>, hostSendTimeMs: number): number {
  const origMs = Number(replyData.origMsgTime);
  if (Number.isFinite(origMs) && origMs > 0) {
    // origMsgTime is seconds in the proto — multiply unless it already looks
    // like milliseconds (post-2001 epoch in ms is > 1e12).
    return origMs > 1e12 ? origMs : origMs * 1000;
  }
  return hostSendTimeMs || 0;
}

/**
 * Render one quoted element. Image / video / animated-emoji / market-face /
 * face all render as small thumbnails — same components as the main bubble,
 * just sized down via CSS (`.qq-reply-preview-media`). File / voice / online
 * file keep the bracket-tag fallback. Plain text/@-mention render inline.
 */
function ReplyPreviewNode({
  element,
  sendTimeMs,
}: {
  element: RenderElement;
  sendTimeMs: number;
}): ReactNode {
  if (element.type === 'face') {
    return <FaceNode data={element.data ?? {}} size="1.4em" />;
  }
  if (element.type === 'pic') {
    return (
      <span className="qq-reply-preview-media">
        <QqImage data={element.data ?? {}} sendTimeMs={sendTimeMs} />
      </span>
    );
  }
  if (element.type === 'video') {
    return (
      <span className="qq-reply-preview-media">
        <QqVideo data={element.data ?? {}} sendTimeMs={sendTimeMs} />
      </span>
    );
  }
  if (element.type === 'mface') {
    return (
      <span className="qq-reply-preview-media">
        <QqMarketFace data={element.data ?? {}} />
      </span>
    );
  }
  if (element.type === 'at') {
    const text = String(element.data?.textContent ?? '');
    return <span className="qq-at-element text-blue-500 font-medium">{text}</span>;
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
 * Compute the best display name for the quoted message's original sender.
 * Tries (in order): the renderer-resolved nick stashed by the host
 * (`origSenderDisplayName`, from MainView's memberMap / self / otherUser
 * resolution), then any other nick-shaped field that might be present, then
 * the QQ uin number, then the uid. Returns null only if nothing is usable.
 */
function origSenderDisplay(data: Record<string, unknown>): string | null {
  const candidates = [
    data.origSenderDisplayName,
    data.origSenderNick,
    data.origSenderName,
    data.origSenderUin,
    data.origSenderUid,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && value > 0) return String(value);
  }
  return null;
}

/**
 * The darker quote box for a `reply` element. Two lines:
 *   line 1 — the original sender's nickname (resolved by the host),
 *   line 2 — a compact preview of the referenced message's last element
 *           with the jump-arrow tucked at its end.
 * Clicking anywhere on the box asks the host to scroll to that message.
 */
function ReplyQuote({
  data,
  sendTimeMs,
}: {
  data: Record<string, unknown>;
  sendTimeMs: number;
}) {
  const jumpToSeq = useContext(ReplyJumpContext);
  const origElements = Array.isArray(data.origElements) ? (data.origElements as RenderElement[]) : [];
  const meaningful = origElements.filter(isMeaningful);
  const preview = meaningful.length > 0 ? meaningful[meaningful.length - 1] : null;
  const senderName = origSenderDisplay(data);
  const quoteTimeMs = quoteSendTimeMs(data, sendTimeMs);
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
      <div className="qq-reply-quote-stack">
        <div className="qq-reply-quote-sender">{senderName ?? '原消息'}</div>
        <div className="qq-reply-quote-body">
          {preview ? <ReplyPreviewNode element={preview} sendTimeMs={quoteTimeMs} /> : <span>引用消息</span>}
          {canJump ? <ArrowUp className="qq-reply-quote-arrow" size={12} strokeWidth={2.4} aria-hidden /> : null}
        </div>
      </div>
    </div>
  );
}

export function QqMessageContent({
  elements,
  sendTimeMs,
  msgId,
  isSender = true,
}: {
  elements: RenderElement[];
  sendTimeMs: number;
  msgId: string;
  isSender?: boolean;
}) {
  // A `multiMsg` element (合并转发) always takes over the whole bubble: it
  // renders as the preview card (title + preview lines + "查看详情" footer).
  // Click → opens a floating ForwardWindow that does the actual sub-message
  // lookup. We pick the FIRST multiMsg element because a message never carries
  // more than one (the proto allows it but QQ NT never produces it).
  // An `ark` element (结构化卡片：图文/地图/小程序/一起听歌/名片/QQ收藏) likewise
  // takes over the whole bubble, rendering as its own self-contained card.
  const arkElement = elements.find((element) => element.type === 'ark');
  if (arkElement) {
    return (
      <div className={cn('message-content', 'qq-card-only', 'qq-has-ark')}>
        <QqArk arkData={arkElement.data?.arkData} />
      </div>
    );
  }

  // A `markdown` element carrying `flashTransferInfo` (QQ 闪传) renders as a flash
  // transfer file card; plain markdown is left to the template's default renderer.
  const flashElement = elements.find((element) => flashTransferInfoOf(element) !== null);
  if (flashElement) {
    return (
      <div className={cn('message-content', 'qq-card-only', 'qq-has-flash')}>
        <QqFlashTransfer
          markdownContent={String(flashElement.data?.markdownContent ?? '')}
          info={flashElement.data?.flashTransferInfo}
        />
      </div>
    );
  }

  // A `wallet` element (转账 / 红包) renders as its own card.
  const walletElement = elements.find((element) => element.type === 'wallet');
  if (walletElement) {
    return (
      <div className={cn('message-content', 'qq-card-only', 'qq-has-wallet')}>
        <QqWallet
          detail={walletElement.data?.walletDetail}
          fallbackType={walletElement.data?.walletRedbagType}
        />
      </div>
    );
  }

  const multiMsgElement = elements.find((element) => element.type === 'multiMsg');
  const forwardKind = useContext(ForwardKindContext);
  if (multiMsgElement) {
    return (
      <div className={cn('message-content', 'qq-card-only', 'qq-has-forward')}>
        <ForwardMultiMsgPreview
          data={(multiMsgElement.data ?? {}) as Record<string, unknown>}
          msgId={msgId}
          kind={forwardKind}
        />
      </div>
    );
  }

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
        <ReplyQuote data={replyElement.data ?? {}} sendTimeMs={sendTimeMs} />
        {meaningful.length > 0 ? (
          <div className="qq-reply-body">
            {renderElementNodes(meaningful, sendTimeMs, msgId, isSender)}
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
            <FaceNode data={data} size={INLINE_SIZE} isSender={isSender} />
          </div>
        );
      }
      return (
        <div className={cn('message-content', 'sticker-only')}>
          <FaceNode data={data} size={STICKER_SIZE} animated isSender={isSender} />
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

  const nodes = renderElementNodes(meaningful, sendTimeMs, msgId, isSender);

  return <div className={cn('message-content', 'qq-message-inline')}>{nodes}</div>;
}

/** Element kinds this renderer claims (reply/face/at + rich media + multiMsg). */
const HANDLED_KINDS = new Set(['reply', 'face', 'at', 'pic', 'video', 'file', 'ptt', 'mface', 'multiMsg', 'ark', 'wallet', 'call', 'onlineFile', 'onlineFolder']);

/** MessageRenderer that handles messages carrying face/at or rich-media elements. */
export const qqMessageRenderer: MessageRenderer = {
  id: 'qq-elements',
  match: ({ message }) => {
    const elements = (message as { qqElements?: RenderElement[] }).qqElements;
    if (!Array.isArray(elements)) return false;
    return elements.some(
      (element) =>
        (element?.type !== undefined && HANDLED_KINDS.has(element.type)) ||
        // Plain markdown stays with the default renderer; only flash-transfer
        // markdown (flashTransferInfo present) is claimed here.
        flashTransferInfoOf(element) !== null,
    );
  },
  render: ({ message, mine }) => {
    const m = message as { qqElements?: RenderElement[]; createdAt?: string; msgId?: string };
    const elements = m.qqElements ?? [];
    const sendTimeMs = m.createdAt ? Date.parse(m.createdAt) : 0;
    const msgId = m.msgId ?? '';
    return <QqMessageContent elements={elements} sendTimeMs={sendTimeMs} msgId={msgId} isSender={mine} />;
  },
};
