/**
 * Renders a group message's sticker reactions (贴表情, SQL column 40062).
 *
 * Layout: a row sitting directly below the original message. Each reaction is a
 * small `FaceEmoji` (the `emojiId` is a QQ faceId) followed by its set count.
 * Reactions wrap to a new row after 7 emoji kinds. A reaction the logged-in
 * account set itself (`isSelfSet`) is highlighted.
 *
 * 悬停：把鼠标放到某一枚表情回应上，会在**鼠标附近**弹出「谁贴了这个表情」的面板
 * （`ReactionLikersPanel`，头像 + 昵称 + QQ 号，自己那行高亮，可分页滚动）。名单要靠
 * 在线的 QQ 实时查（0x9083_1）—— 本地只有计数，所以没传 groupId / sequence（非群聊、
 * 或这条消息没有会话内序号）时面板不开，退化回原来的 title 提示。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetEmojiItem } from '@weq/codec';
import { FaceEmoji } from './FaceEmoji';
import { ReactionLikersPanel } from './ReactionLikersPanel';
import { cn } from '@renderer/lib/utils';

/** Reaction emoji box size; smaller than an inline face. */
const REACTION_FACE_SIZE = 18;

/** 悬停多久才弹出：手指划过去 / 鼠标路过不打扰。 */
const OPEN_DELAY_MS = 180;

/** 离开后多久才关：留出从 chip 移到面板上的时间（面板自己会取消这个定时器）。 */
const CLOSE_DELAY_MS = 220;

/** 弹出面板的状态。`x/y` 是鼠标位置（client 坐标）。 */
type OpenState = { emojiId: string; setNum: number; x: number; y: number };
export interface ReactionInteraction {
  onChange: (code: string, isSet: boolean) => void;
  blockedReason?: string | null;
  busy?: boolean;
}

/** 一枚表情回应本体：能认出是 QQ 表情就画表情，否则退化成原始 id 文本。 */
function ReactionEmoji({ emojiId, label }: { emojiId: string; label?: string }) {
  const faceId = Number(emojiId);
  if (Number.isInteger(faceId)) {
    return <FaceEmoji element={{ faceId }} size={REACTION_FACE_SIZE} />;
  }
  return (
    <span className={cn('msg-reaction-raw')} title={label}>
      {emojiId}
    </span>
  );
}

export function SetEmojiReactions({
  list,
  groupId,
  sequence,
  interaction,
}: {
  list?: SetEmojiItem[];
  /** 群号；非群聊不传 —— 没有它就没有回应人名单可查。 */
  groupId?: string | number | null;
  /** 被回应消息的 msgSeq；0 / 缺省表示这条消息没有会话内序号。 */
  sequence?: number;
  interaction?: ReactionInteraction;
}) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canQuery = Boolean(groupId) && Number.isFinite(sequence) && Number(sequence) > 0;

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  /** 悬停一枚 chip：延时后在鼠标位置弹出。 */
  const scheduleOpen = useCallback(
    (item: SetEmojiItem, event: { clientX: number; clientY: number }) => {
      if (!canQuery || !groupId) return;
      clearTimers();
      const x = event.clientX;
      const y = event.clientY;
      openTimer.current = setTimeout(() => {
        setOpen({ emojiId: item.emojiId, setNum: item.setNum, x, y });
      }, OPEN_DELAY_MS);
    },
    [canQuery, clearTimers, groupId],
  );

  /** 离开 chip：延时关闭（期间指针移进面板就取消）。 */
  const scheduleClose = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(null), CLOSE_DELAY_MS);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  if (!list || list.length === 0) return null;

  return (
    <>
      <div className={cn('msg-reactions')}>
        {list.map((item) => {
          const active = open?.emojiId === item.emojiId;
          const canChange = Boolean(
            interaction && !interaction.blockedReason && !interaction.busy && canQuery,
          );
          const actionLabel = item.isSelfSet
            ? `撤回贴表情 ${item.emojiId}`
            : `跟贴表情 ${item.emojiId}`;
          return (
            <button
              type="button"
              key={item.emojiId}
              className={cn('msg-reaction', item.isSelfSet && 'is-self', active && 'is-open')}
              title={
                canChange
                  ? actionLabel
                  : interaction?.blockedReason ||
                    (canQuery ? `${item.emojiId} · 悬停查看谁贴了` : item.emojiId)
              }
              disabled={!canQuery || Boolean(interaction?.busy)}
              aria-pressed={interaction ? item.isSelfSet : undefined}
              // 只有能查名单时才是「可交互」的：给键盘用户同一份能力。
              {...(canQuery
                ? {
                    tabIndex: 0,
                    role: 'button',
                    'aria-label': canChange ? actionLabel : `查看 ${item.emojiId} 的回应人`,
                  }
                : {})}
              onPointerEnter={(event) => scheduleOpen(item, event)}
              onClick={(event) => {
                if (canChange && interaction) {
                  clearTimers();
                  setOpen(null);
                  interaction.onChange(item.emojiId, !item.isSelfSet);
                } else {
                  const rect = event.currentTarget.getBoundingClientRect();
                  scheduleOpen(
                    item,
                    event.detail === 0 ? { clientX: rect.left, clientY: rect.bottom } : event,
                  );
                }
              }}
              onPointerLeave={scheduleClose}
              onFocus={(event) =>
                scheduleOpen(item, {
                  clientX: event.currentTarget.getBoundingClientRect().left,
                  clientY: event.currentTarget.getBoundingClientRect().bottom,
                })
              }
              onBlur={scheduleClose}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setOpen(null);
              }}
            >
              <ReactionEmoji emojiId={item.emojiId} label={item.emojiId} />
              <span className={cn('msg-reaction-count')}>{item.setNum}</span>
            </button>
          );
        })}
      </div>
      {open && canQuery && groupId ? (
        <ReactionLikersPanel
          anchor={{ x: open.x, y: open.y }}
          groupId={String(groupId)}
          sequence={Number(sequence)}
          emojiId={open.emojiId}
          setNum={open.setNum}
          emojiLabel={open.emojiId}
          icon={<ReactionEmoji emojiId={open.emojiId} label={open.emojiId} />}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onClose={() => {
            clearTimers();
            setOpen(null);
          }}
        />
      ) : null}
    </>
  );
}
