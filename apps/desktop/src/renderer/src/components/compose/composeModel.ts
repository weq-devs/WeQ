/**
 * Compose data model — the frontend's authoring representation of a new message
 * and the converters into (a) the render form used for the live preview and
 * (b) the wire form sent to `account.insertMessage`.
 *
 * A message is an ordered list of {@link Segment}s. Text/at/face are authored
 * inline; pic reuses a real `pic` element lifted from an existing message (so
 * its CDN fields stay valid — we can't upload new images from an offline DB
 * tool). An optional reply is prepended separately by the modal.
 */

/** One authored piece of a message. */
export type Segment =
  | { t: 'text'; id: string; text: string }
  | { t: 'at'; id: string; uid: string; uin: string; name: string }
  | { t: 'face'; id: string; faceId: number; faceText: string }
  /** `codec` = editable-wire pic element (for submit); `preview` = render element. */
  | { t: 'pic'; id: string; codec: Record<string, unknown>; preview: RenderEl };

/** A message picked as the reply target. */
export interface ReplyTarget {
  msgId: string;
  msgSeq: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  /** Plain-text summary shown in the quote line. */
  summary: string;
}

/** The render-view element shape consumed by QqMessageContent. */
export interface RenderEl {
  type?: string;
  data?: Record<string, unknown>;
}

let seq = 0;
export function nextId(): string {
  seq += 1;
  return `seg-${seq}`;
}

/** Content kinds (a message needs at least one). */
export function hasContent(segs: Segment[]): boolean {
  return segs.some((s) => s.t !== 'text' || s.text.trim().length > 0);
}

/**
 * Convert authored segments into the wire elements posted to insertMessage.
 * Empty text segments are dropped. `@` mentions are encoded as TEXT elements
 * carrying the target uid in `bubbleId` and uin in `textEncodingFlag` — the
 * shape QQ uses (and what decodeElement keys 'at' off of).
 */
export function toWireElements(segs: Segment[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const s of segs) {
    if (s.t === 'text') {
      const text = s.text;
      if (text.length === 0) continue;
      out.push({ kind: 'text', textContent: text });
    } else if (s.t === 'at') {
      out.push({
        kind: 'at',
        textContent: `@${s.name} `,
        bubbleId: s.uid,
        textReserve: 2,
        textEncodingFlag: Number(s.uin) || 0,
        atMentionMask: '',
      });
    } else if (s.t === 'face') {
      out.push({ kind: 'face', faceId: s.faceId, faceText: s.faceText });
    } else if (s.t === 'pic') {
      out.push(s.codec);
    }
  }
  return out;
}

/**
 * Build the leading `reply` element from a picked target. Group replies omit
 * origReceiverUid/origMsgIndex in the wild, but the compose schema requires them,
 * so we supply harmless fillers. `origElements` carries a single synthesized text
 * element so the stored quote renders a preview instead of "引用消息".
 */
export function toReplyElement(target: ReplyTarget, peerUid: string): Record<string, unknown> {
  const seqNum = Number(target.msgSeq) || 0;
  return {
    kind: 'reply',
    origSenderUid: target.senderUid,
    origReceiverUid: peerUid,
    origMsgSeq: seqNum,
    origSenderUin: Number(target.senderUin) || 0,
    origMsgTime: Number(target.sendTime) || 0,
    origReceiverUin: 0,
    origMsgId: target.msgId,
    origMsgIndex: seqNum,
    replyFlag47422: target.msgId,
    origElements: [{ elementType: 1, textContent: target.summary || '引用消息' }],
  };
}

/** Convert authored segments into render elements for the live preview. */
export function toPreviewElements(segs: Segment[]): RenderEl[] {
  const out: RenderEl[] = [];
  for (const s of segs) {
    if (s.t === 'text') {
      if (s.text.length === 0) continue;
      out.push({ type: 'text', data: { textContent: s.text } });
    } else if (s.t === 'at') {
      out.push({ type: 'at', data: { textContent: `@${s.name} ` } });
    } else if (s.t === 'face') {
      out.push({ type: 'face', data: { faceId: s.faceId, faceText: s.faceText, subType: 1 } });
    } else if (s.t === 'pic') {
      out.push(s.preview);
    }
  }
  return out;
}

/** Flatten a message's render elements into a short plain-text summary. */
export function summarize(elements: RenderEl[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    const data = el.data ?? {};
    switch (el.type) {
      case 'text':
      case 'at':
        parts.push(String(data.textContent ?? ''));
        break;
      case 'face':
        parts.push(String(data.faceText ?? '[表情]'));
        break;
      case 'pic':
        parts.push('[图片]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'file':
        parts.push('[文件]');
        break;
      case 'ptt':
        parts.push('[语音]');
        break;
      case 'mface':
        parts.push('[动画表情]');
        break;
      case 'reply':
        break;
      default:
        if (typeof data.textContent === 'string') parts.push(data.textContent);
    }
  }
  const text = parts.join('').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || '[消息]';
}
