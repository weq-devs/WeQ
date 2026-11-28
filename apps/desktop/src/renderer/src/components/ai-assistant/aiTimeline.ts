/**
 * AI 助手消息 → ChatPane 时间线。
 *
 * 普通元素沿用 `qqElements`，小Q 正文和交互元素由 `aiPayload` 提供。
 */

import { unixDate } from '@weq/time';
import type { DirectConversation, Message, User } from '../../im-template/template/types';
import type { AiAssistantMessageWire } from '../../../../shared/aiAssistantTypes';
import type { AiMessagePayload } from './AiMessageContent';

/** 渲染器认领消息时读取的字段名。 */
export const AI_PAYLOAD_KEY = 'aiPayload';

export function aiMessagesToTimeline(
  rows: readonly AiAssistantMessageWire[],
  conversation: DirectConversation,
  user: User,
): Array<Message & { [AI_PAYLOAD_KEY]?: AiMessagePayload }> {
  return rows.map((row) => {
    const sender = row.mine ? user : conversation.otherUser;
    const qqElements: AiAssistantMessageWire['elements'] = [];
    const controls: AiAssistantMessageWire['elements'] = [];
    for (const element of row.elements) {
      if (element.type === 'actionBar' || element.type === 'recommendedMsg') {
        controls.push(element);
      } else {
        qqElements.push(element);
      }
    }
    return {
      id: row.msgId,
      msgId: row.msgId,
      msgSeq: row.msgSeq,
      conversationId: conversation.id,
      body: aiWireText(row),
      senderId: sender.id,
      sender,
      createdAt: Number(row.sendTime) > 0 ? (unixDate(row.sendTime)?.toISOString() ?? '') : '',
      // 含 AI 正文的消息用 body 保留复制文本，避免只复制到附带的 QQ 元素。
      qqElements: row.segments.length ? undefined : qqElements,
      ...(row.segments.length || controls.length
        ? {
            [AI_PAYLOAD_KEY]: {
              segments: row.segments,
              elements: controls,
              ordinaryElements: row.segments.length ? qqElements : undefined,
            },
          }
        : {}),
    };
  });
}

/**
 * 纯文本：正文片段拼接；用户提问没有 segments，退回普通元素里的文本。
 * 卡片段使用 Markdown 标签，保留候选昵称及链接标题。
 */
export function aiWireText(row: AiAssistantMessageWire): string {
  if (row.segments.length === 0) {
    return row.elements
      .map((element) => {
        if (element.type === 'text' || element.type === 'at')
          return String(element.data?.textContent ?? '');
        return '';
      })
      .join('')
      .trim();
  }
  return row.segments
    .map((segment) => (segment.kind === 'text' ? segment.text : (segment.label ?? '')))
    .join('')
    .trim();
}
