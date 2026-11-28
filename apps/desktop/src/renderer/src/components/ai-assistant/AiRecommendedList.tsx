/**
 * AI 回复底部的推荐消息（elementType=43）：AI 猜你接下来想问的几个问题。
 *
 * 结构与内联键盘相同（行 → 按钮），按钮 label 就是点击后要发送的文本。
 * AI 助手不发消息，所以这些按钮**只读**：视觉上保持胶囊按钮的样子，点击无效，
 * 悬停给出说明，用户想追问得自己去 QQ 里发。
 */

import { Sparkles } from 'lucide-react';
import type { AiButtonRows } from './AiMessageContent';

export function AiRecommendedList({ rows }: { rows?: AiButtonRows }) {
  const buttons = (rows ?? []).flat().filter((button) => Boolean(button.label));
  if (!buttons.length) return null;
  return (
    <div className="ai-recommended">
      <div className="ai-recommended-head">
        <Sparkles size={13} aria-hidden />
        <span>你可能想问</span>
      </div>
      <div className="ai-recommended-list">
        {buttons.map((button) => (
          <span
            key={button.label}
            className="ai-recommended-chip"
            title="AI 助手只读，需要追问请在 QQ 内发送"
            aria-disabled="true"
          >
            {button.label}
          </span>
        ))}
      </div>
    </div>
  );
}
