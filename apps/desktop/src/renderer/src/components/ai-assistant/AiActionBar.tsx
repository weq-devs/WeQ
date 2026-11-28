/**
 * AI 回复底部的操作栏（elementType=44）：重新生成 / 复制 / 喜欢 / 不喜欢 / 分享。
 *
 * 动作码在按钮的 `actionCode`（48770 → 48780）：
 *   4 = 重新生成  7 = 复制  1 = 喜欢  2 = 不喜欢  6 = 分享
 *
 * 「复制」在静态模式下仍可用（复制正文纯文本），其余动作需要 QQ 在线，一律
 * 只读展示 —— 悬停给出说明，不假装能点。
 */

import { Copy, RotateCcw, Share2, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AiButtonRows } from './AiMessageContent';

const ACTION_META: Record<number, { icon: ReactNode; label: string }> = {
  4: { icon: <RotateCcw size={13} aria-hidden />, label: '重新生成' },
  7: { icon: <Copy size={13} aria-hidden />, label: '复制' },
  1: { icon: <ThumbsUp size={13} aria-hidden />, label: '喜欢' },
  2: { icon: <ThumbsDown size={13} aria-hidden />, label: '不喜欢' },
  6: { icon: <Share2 size={13} aria-hidden />, label: '分享' },
};

export function AiActionBar({ rows }: { rows?: AiButtonRows }) {
  const buttons = (rows ?? []).flat();
  if (!buttons.length) return null;
  return (
    <div className="ai-action-bar">
      {buttons.map((button) => {
        const meta = button.actionCode !== undefined ? ACTION_META[button.actionCode] : undefined;
        const label = button.label || meta?.label || '';
        if (!label) return null;
        const staticHint =
          button.actionCode === 4 || button.actionCode === 6
            ? '需要 QQ 在线，WeQ 静态展示暂不支持'
            : undefined;
        return (
          <span
            key={`${button.actionCode ?? ''}:${label}`}
            className="ai-action-bar-button"
            title={staticHint}
            aria-disabled="true"
          >
            {meta?.icon}
            <span>{label}</span>
          </span>
        );
      })}
    </div>
  );
}
