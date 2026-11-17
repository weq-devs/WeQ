import type { MessageRenderer } from '../im-template/template';
import { textMarkdownKey } from '../state/textMarkdown';
import { QqMessageContent } from './QqMessageContent';

export type RenderElement = {
  type?: string;
  data?: Record<string, unknown>;
};

/** Element kinds this renderer claims (text/reply/face/at + rich media + markdown + multiMsg + cards). */
const HANDLED_KINDS = new Set([
  'text',
  'reply',
  'face',
  'at',
  'pic',
  'video',
  'bubbleVideo',
  'file',
  'ptt',
  'mface',
  'markdown',
  'multiMsg',
  'structLongMsg',
  'inlineKeyboard',
  'ark',
  'wallet',
  'call',
  'onlineFile',
  'onlineFolder',
  'shareLocation',
  'qqDynamic',
  'emojiBounce',
]);

/**
 * MessageRenderer that handles every element kind we draw ourselves — text,
 * face/at, rich media, cards, markdown. Only kinds absent from HANDLED_KINDS
 * (gray tips, which chatPane renders itself, and unknown-with-body) fall
 * through to the template's plain-text fallback.
 */
export const qqMessageRenderer: MessageRenderer = {
  id: 'qq-elements',
  match: ({ message }) => {
    const elements = (message as { qqElements?: RenderElement[] }).qqElements;
    if (!Array.isArray(elements)) return false;
    return elements.some(
      (element) => element?.type !== undefined && HANDLED_KINDS.has(element.type),
    );
  },
  render: ({ message, conversation, mine }) => {
    const m = message as {
      qqElements?: RenderElement[];
      createdAt?: string;
      msgId?: string;
      msgSeq?: string;
    };
    const elements = m.qqElements ?? [];
    const sendTimeMs = m.createdAt ? Date.parse(m.createdAt) : 0;
    const msgId = m.msgId ?? '';
    return (
      <QqMessageContent
        elements={elements}
        sendTimeMs={sendTimeMs}
        msgId={msgId}
        galleryKey={message.id}
        msgSeq={m.msgSeq}
        isSender={mine}
        conversation={conversation}
        textMarkdownDisplayKey={textMarkdownKey(message)}
      />
    );
  },
};
