// @ts-nocheck
/**
 * 输入框的「引用」：右键消息 → 引用，在输入框上方挂一条引用条，发送时把被引用消息
 * 编成 `reply` 元素跟着正文一起发出去。
 *
 * 只描述**前端待发送的引用**，不碰协议：
 *   - 引用条上的昵称 / 摘要只是给人看的，不进 wire；
 *   - 真正送出去的只有 `{ kind: 'reply', origMsgSeq, origSenderUin, origMsgTime }`
 *     —— 与 `@weq/service` 的 `buildTextElements`（replyToMsgSeq 那一路）完全同形，
 *     所以走草稿里既有的「元素 token」通路即可。
 *
 * **允许嵌套引用**（引用的消息自己也是引用）：回复元素只带引用指针（seq / uin / 时间），
 * 不带被引消息的元素清单，所以「排除原消息引用的那个元素」天然成立 —— 原消息自带的
 * reply 元素永远不会被带到新引用里。摘要那一路同理：{@link quotePreview} 会把原消息自己的
 * reply 元素跳掉，不把上一层的引用带进引用条（见 {@link withoutReplyElements}）。
 *
 * 唯一不给引的是**系统灰条**（拍一拍 / 撤回 / 群通知…）—— 它们本来就没有可引的内容。
 *
 * 与「只能单独发」的槽位（视频 / 文件 / 超级表情）互斥由 chatPane 负责：挂上任意
 * 一边就会把另一边清掉 —— 这个槽位一次只放一样东西。
 */

import { X } from 'lucide-react';
import type { RefObject } from 'react';
import { cn } from './classNames';
import { elementToToken } from './draftElements';
import type { Message } from './types';

/** 引用条 + 待发送的引用。 */
export type ComposerQuote = {
  /** 被引用消息的会话内序号（群 / 私聊都是 msgSeq）。 */
  msgSeq: number;
  /** 被引用消息发送者的 QQ 号（可选，带上更稳）。 */
  senderUin?: number;
  /** 被引用消息的发送时间（unix 秒，可选）。 */
  msgTime?: number;
  /** 以下三项只用于输入框上方的引用条展示，不进 wire。 */
  senderName: string;
  preview: string;
};

/** 系统灰条等「没有可引内容」的元素 kind 前缀 / 名单。 */
const UNQUOTABLE_KINDS = new Set(['call', 'qqDynamic', 'wallet', 'shareLocation']);

/** 摘要里给非文本元素的占位标签（与 lib/conversationPreview 的口径一致）。 */
const PREVIEW_LABELS: Record<string, string> = {
  pic: '[图片]',
  file: '[文件]',
  onlineFile: '[在线文件]',
  onlineFolder: '[在线文件夹]',
  video: '[视频]',
  bubbleVideo: '[视频]',
  ptt: '[语音]',
  face: '[表情]',
  mface: '[表情]',
  ark: '[卡片]',
  markdown: '[卡片]',
  multiMsg: '[合并转发]',
  wallet: '[红包]',
  shareLocation: '[位置]',
  qqDynamic: '[动态]',
};

type MessageElement = { type?: unknown; data?: Record<string, unknown> };

function messageElements(message: Message): MessageElement[] {
  const elements = (message as { qqElements?: MessageElement[] }).qqElements;
  return Array.isArray(elements) ? elements : [];
}

/** 丢掉元素清单里的 reply 元素 —— 嵌套引用时「原消息引用的那个元素」就该排掉。 */
function withoutReplyElements(elements: MessageElement[]): MessageElement[] {
  return elements.filter((element) => element?.type !== 'reply');
}

/** 元素 → 给人看的摘要素（文本 / @ 取字面值，媒体取占位标签，其余忽略）。 */
function elementPreviewText(element: MessageElement): string {
  const type = typeof element?.type === 'string' ? element.type : '';
  if (type === 'text' || type === 'at') {
    const text = element?.data?.textContent;
    return typeof text === 'string' ? text : '';
  }
  return PREVIEW_LABELS[type] ?? '';
}

/**
 * 这条消息能不能引用。返回 null = 可以，否则返回不能引用的原因（给菜单按钮做禁用提示）。
 *
 * **嵌套引用是允许的**（引用的消息自己也是引用时，只把它的 reply 元素排掉）；
 * 只有缺会话内序号的本地乐观消息和系统灰条不给引。
 */
export function quoteBlockReason(message: Message): string | null {
  const seq = Number((message as { msgSeq?: unknown }).msgSeq);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    return '这条消息没有会话内序号，暂不支持引用';
  }

  const kinds = messageElements(message).map((element) =>
    typeof element?.type === 'string' ? element.type : '',
  );
  if (kinds.some((kind) => kind.startsWith('grayTip') || UNQUOTABLE_KINDS.has(kind))) {
    return '系统消息不支持引用';
  }
  return null;
}

/**
 * 引用条上的摘要：
 *   - 原消息自己也是引用时，**先把它那条 reply 元素排掉**，只承接下来的正文 / 媒体
 *     （body 是整条消息拼出来的，直接拿会把上一层的「[引用] …」一起带进来）；
 *   - 其余情况直接用 body（宿主已经做过富媒体文案映射，比这里重算更准）。
 * 都取不到内容时给一个兜底文案。
 */
function quotePreview(message: Message): string {
  const elements = messageElements(message);
  const nested = elements.some((element) => element?.type === 'reply');
  const raw = nested
    ? withoutReplyElements(elements).map(elementPreviewText).join('')
    : String(message.body ?? '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 0 ? flat : '[消息]';
}

/**
 * 把一条消息折成待发送的引用；不可引用时返回 null（调用方按
 * {@link quoteBlockReason} 给提示）。
 */
export function quoteFromMessage(message: Message): ComposerQuote | null {
  if (quoteBlockReason(message)) return null;

  const senderUin = Number(message.sender?.identityValue ?? '');
  const seconds = Math.floor(Date.parse(message.createdAt ?? '') / 1000);
  return {
    msgSeq: Number((message as { msgSeq?: unknown }).msgSeq),
    ...(Number.isSafeInteger(senderUin) && senderUin > 0 ? { senderUin } : {}),
    ...(Number.isFinite(seconds) && seconds > 0 ? { msgTime: seconds } : {}),
    senderName: String(message.sender?.displayName ?? '').trim(),
    preview: quotePreview(message),
  };
}

/**
 * 待发送的引用 → wire 元素（与 service 的 buildTextElements 同形）。
 *
 * 只带引用指针，**不带被引消息的元素清单**：所以引用一条「自己也是引用」的消息时，
 * 那条消息里的 reply 元素不会跟着到新引用里（嵌套引用只需要排除这一个元素）。
 */
export function composerQuoteElement(quote: ComposerQuote): Record<string, unknown> {
  return {
    kind: 'reply',
    origMsgSeq: quote.msgSeq,
    ...(quote.senderUin !== undefined ? { origSenderUin: quote.senderUin } : {}),
    ...(quote.msgTime !== undefined ? { origMsgTime: quote.msgTime } : {}),
  };
}

/** 待发送的引用 → 元素 token（跟草稿正文同一条通路）。 */
export function composerQuoteToken(quote: ComposerQuote): string {
  return elementToToken(composerQuoteElement(quote));
}

/**
 * 输入框上方那条引用条：左侧一根强调色竖条 + 昵称 + 单行摘要 + 取消。
 * 它占 `.composer` 网格里正文上面那一行（见 composer-media.css 的 `.composer-quote`），
 * 所以有引用时正文会短一截，而不是把引用压在正文上。
 */
export function ComposerQuoteBar({
  quote,
  panelRef,
  onRemove,
}: {
  quote: ComposerQuote;
  panelRef?: RefObject<HTMLDivElement | null>;
  onRemove: () => void;
}) {
  return (
    <div className={cn('composer-quote')} ref={panelRef} aria-label="待发送的引用">
      <span className={cn('composer-quote-rail')} aria-hidden="true" />
      <span className={cn('composer-quote-body')}>
        <strong>{quote.senderName || '原消息'}</strong>
        <em title={quote.preview}>{quote.preview}</em>
      </span>
      <button
        type="button"
        className={cn('composer-quote-remove')}
        title="取消引用"
        aria-label="取消引用"
        onClick={onRemove}
      >
        <X size={13} strokeWidth={2.6} />
      </button>
    </div>
  );
}
