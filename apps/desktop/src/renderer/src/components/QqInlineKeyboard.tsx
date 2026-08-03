/**
 * 机器人内联键盘 (elementType=17 / INLINE_KEYBOARD).
 *
 * 机器人卡片底部的按钮组，与同一条消息里的 markdown 正文成对出现。按钮按行分组，
 * 一行内的按钮等宽平分。
 *
 * 按钮只是**展示**：真正的点击要回调机器人后端，本地库没有那条链路。带 http(s)
 * 链接的按钮（actionType=2）可以打开，其余按钮渲染成不可点的样子 —— 与其假装能
 * 点然后什么都不发生，不如一眼看出来。
 */

import { ExternalLink } from 'lucide-react';
import { openLink } from '../lib/linkify';

export interface KeyboardButton {
  label: string;
  action: string;
  actionType: number;
}

const BTN_BASE =
  'flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg ' +
  'border text-sm truncate transition-colors';

export function QqInlineKeyboard({ rows }: { rows: KeyboardButton[][] }) {
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 mt-2">
      {rows.map((row, rowIndex) => (
        // 按钮没有稳定 id（48754 只在一条消息内唯一），行内顺序就是身份。
        // biome-ignore lint/suspicious/noArrayIndexKey: 行顺序即身份，无稳定 id
        <div key={rowIndex} className="flex gap-2">
          {row.map((button, buttonIndex) => {
            const href = /^https?:\/\//i.test(button.action) ? button.action : null;
            return href ? (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                key={buttonIndex}
                type="button"
                className={`${BTN_BASE} border-blue-400/60 text-blue-500 hover:bg-blue-500/10 cursor-pointer`}
                title={href}
                onClick={() => openLink(href)}
              >
                <ExternalLink size={13} className="shrink-0" />
                <span className="truncate">{button.label}</span>
              </button>
            ) : (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                key={buttonIndex}
                className={`${BTN_BASE} border-border text-muted-foreground cursor-default`}
                title={button.action || undefined}
              >
                <span className="truncate">{button.label}</span>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
