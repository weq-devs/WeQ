/**
 * AI 助手消息的渲染器。
 *
 * 小Q 专用内容由 AiMessageContent 渲染，同条消息里的普通元素复用 QQ 渲染器。
 */

import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import { qqMessageRenderer } from '../QqMessageContent.shared';
import { AiMessageContent, type AiMessagePayload } from './AiMessageContent';
import { AI_PAYLOAD_KEY } from './aiTimeline';

export const aiMessageRenderer: MessageRenderer = {
  id: 'ai-assistant',
  match: ({ message }) => {
    const payload = (message as Record<string, unknown>)[AI_PAYLOAD_KEY];
    return Boolean(payload && typeof payload === 'object');
  },
  render: (context) => {
    const payload = (context.message as Record<string, unknown>)[AI_PAYLOAD_KEY] as
      | AiMessagePayload
      | undefined;
    if (!payload) return null;
    const qqContext = payload.ordinaryElements
      ? { ...context, message: { ...context.message, qqElements: payload.ordinaryElements } }
      : context;
    return (
      <AiMessageContent payload={payload}>
        {qqMessageRenderer.match(qqContext) ? qqMessageRenderer.render(qqContext) : null}
      </AiMessageContent>
    );
  },
};
