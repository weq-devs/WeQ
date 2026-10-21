/**
 * 机器人内联键盘 (elementType=17 / INLINE_KEYBOARD).
 *
 * 机器人卡片底部的按钮组，与同一条消息里的 markdown 正文成对出现。按钮按行分组，
 * 一行内的按钮等宽平分。
 *
 * 链接按钮沿用外部链接处理；回调按钮只有在原消息定位及机器人身份齐全时才启用。
 * 转发预览或缺失元数据的按钮保持只读，不用外层消息的位置伪造回调。
 */

import { ExternalLink } from 'lucide-react';
import { openLink } from '../lib/linkify';
import { client } from '../trpc/client';
import { ActionFeedback, useQQAction } from './qq-actions/shared';

export interface KeyboardButton {
  buttonId?: string;
  label: string;
  action: string;
  actionType: number;
}

const BTN_BASE =
  'flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg ' +
  'border text-sm truncate transition-colors';

export function QqInlineKeyboard({
  rows,
  groupId,
  sequence,
  botAppid,
}: {
  rows: KeyboardButton[][];
  groupId?: string;
  sequence?: string;
  botAppid?: string;
}) {
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
            ) : button.actionType === 1 &&
              button.buttonId &&
              groupId &&
              sequence &&
              botAppid &&
              /^[1-9]\d*$/.test(groupId) &&
              /^[1-9]\d*$/.test(sequence) &&
              /^[1-9]\d*$/.test(botAppid) ? (
              <CallbackButton
                key={button.buttonId}
                button={button}
                groupId={groupId}
                sequence={sequence}
                botAppid={botAppid}
              />
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

function CallbackButton({
  button,
  groupId,
  sequence,
  botAppid,
}: {
  button: KeyboardButton;
  groupId: string;
  sequence: string;
  botAppid: string;
}) {
  const a = useQQAction(`keyboard:${groupId}:${sequence}:${button.buttonId}`);
  return (
    <div className="weq-qq-keyboard-action">
      <button
        type="button"
        className={`${BTN_BASE} border-border text-foreground`}
        disabled={a.disabled}
        title={button.label}
        onClick={() =>
          void a.perform(
            (b) =>
              client.account.qqActions.inlineButton.mutate({
                ...b,
                groupId: Number(groupId),
                sequence,
                botAppid,
                buttonId: button.buttonId!,
                callbackData: button.action,
              }),
            undefined,
            `向机器人提交「${button.label}」？`,
          )
        }
      >
        {button.label}
      </button>
      <ActionFeedback action={a} />
    </div>
  );
}
