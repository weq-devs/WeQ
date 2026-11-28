/**
 * AI 助手消息的渲染器。
 *
 * `aiTimeline` 把消息折成 ChatPane 的 `Message` 时挂了 `aiPayload`；这里认领
 * 带该字段的消息，交给 `AiMessageContent` 画。没有 payload 的消息（不该出现）
 * 直接不认领，回落到模板的纯文本兜底。
 */

import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import { AiMessageContent, type AiMessagePayload } from './AiMessageContent';
import { AI_PAYLOAD_KEY } from './aiTimeline';

export const aiMessageRenderer: MessageRenderer = {
  id: 'ai-assistant',
  match: ({ message }) => {
    const payload = (message as Record<string, unknown>)[AI_PAYLOAD_KEY];
    return Boolean(payload && typeof payload === 'object');
  },
  render: ({ message }) => {
    const payload = (message as Record<string, unknown>)[AI_PAYLOAD_KEY] as
      | AiMessagePayload
      | undefined;
    if (!payload) return null;
    return <AiMessageContent payload={payload} />;
  },
};
