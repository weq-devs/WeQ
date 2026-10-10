import {
  AtSign,
  ChevronRight,
  Hand,
  MicOff,
  Pencil,
  ShieldMinus,
  ShieldPlus,
  UserMinus,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { User } from './types';
import { cn } from './classNames';

export type AvatarContextMenuState = {
  sender: User;
  x: number;
  y: number;
};

/** 禁言时长档位（与 QQ 桌面端右键一致）。 */
const MUTE_DURATIONS: Array<{ label: string; seconds: number }> = [
  { label: '10 分钟', seconds: 10 * 60 },
  { label: '1 小时', seconds: 60 * 60 },
  { label: '12 小时', seconds: 12 * 60 * 60 },
  { label: '1 天', seconds: 24 * 60 * 60 },
];

/**
 * 右键消息里某个头像弹出的菜单：
 *   - 「@Ta」把 `@昵称 ` 写进输入框（纯前端编辑，不限在线状态）；
 *   - 「戳一戳」走 OIDB 0xED3_1 发包，需要在线且已注入的 QQ —— 不可用时置灰并说明原因；
 *   - 群管理（改群昵称 / 踢人 / 禁言 / 设撤管理员）仅在「我」是群主或管理员、且目标
 *     职权低于自己时出现，同样受发送按钮那套在线 gate 约束（`moderationBlockedReason`）。
 *
 * 所有群管理操作都**不做乐观渲染**：点完只等应用层 toast + QQ 同步，菜单随即关闭。
 */
export function AvatarContextMenu({
  state,
  onMention,
  onPoke,
  pokeBlockedReason,
  onChangeCard,
  onKick,
  onMute,
  onToggleAdmin,
  showChangeCard = false,
  showKick = false,
  showMute = false,
  showSetAdmin = false,
  showUnsetAdmin = false,
  moderationBlockedReason,
}: {
  state: AvatarContextMenuState;
  onMention: (sender: User) => void;
  onPoke: (sender: User) => void;
  /** 非空 = 这条会话当前不能戳（QQ 未在线 / 完全离线模式），按钮置灰并显示原因。 */
  pokeBlockedReason?: string | null;
  /** 修改群昵称（自己 / 职权更低的群友）。 */
  onChangeCard?: (sender: User) => void;
  /** 踢出群聊（职权更低的群友）。 */
  onKick?: (sender: User) => void;
  /** 设置禁言，`durationSeconds` 为秒。 */
  onMute?: (sender: User, durationSeconds: number) => void;
  /** 设置 / 取消管理员（仅群主）。 */
  onToggleAdmin?: (sender: User, enable: boolean) => void;
  showChangeCard?: boolean;
  showKick?: boolean;
  showMute?: boolean;
  showSetAdmin?: boolean;
  showUnsetAdmin?: boolean;
  /** 非空 = 群管理操作不可执行（与发送按钮同条件），按钮置灰并显示原因。 */
  moderationBlockedReason?: string | null;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [muteOpen, setMuteOpen] = useState(false);
  const moderationDisabled = Boolean(moderationBlockedReason);
  const hasModeration = showChangeCard || showKick || showMute || showSetAdmin || showUnsetAdmin;

  // 与 MessageContextMenu 同款：fixed 定位后按渲染尺寸拉回窗口内。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 8;
    el.style.left = `${Math.min(
      Math.max(state.x, margin),
      Math.max(margin, window.innerWidth - rect.width - margin),
    )}px`;
    el.style.top = `${Math.min(
      Math.max(state.y, margin),
      Math.max(margin, window.innerHeight - rect.height - margin),
    )}px`;
  }, [state.x, state.y, muteOpen]);

  return (
    <div
      ref={menuRef}
      className={cn('message-context-menu', 'avatar-context-menu')}
      style={{ left: state.x, top: state.y }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <button type="button" title="在输入框里 @ 这个人" onClick={() => onMention(state.sender)}>
        <AtSign size={17} />
        <span>@Ta</span>
      </button>
      <button
        type="button"
        title={pokeBlockedReason ?? '戳一戳'}
        disabled={Boolean(pokeBlockedReason)}
        onClick={() => onPoke(state.sender)}
      >
        <Hand size={17} />
        <span>戳一戳</span>
      </button>

      {hasModeration ? <div className={cn('message-context-menu-separator')} /> : null}

      {showChangeCard && onChangeCard ? (
        <button
          type="button"
          title={moderationBlockedReason ?? '修改群昵称'}
          disabled={moderationDisabled}
          onClick={() => onChangeCard(state.sender)}
        >
          <Pencil size={17} />
          <span>修改群昵称</span>
        </button>
      ) : null}
      {showKick && onKick ? (
        <button
          type="button"
          title={moderationBlockedReason ?? '踢出群聊'}
          disabled={moderationDisabled}
          onClick={() => onKick(state.sender)}
        >
          <UserMinus size={17} />
          <span>踢出群聊</span>
        </button>
      ) : null}
      {showMute && onMute ? (
        <>
          <button
            type="button"
            className={cn('avatar-context-menu-mute')}
            title={moderationBlockedReason ?? '设置禁言'}
            disabled={moderationDisabled}
            onClick={() => setMuteOpen((open) => !open)}
          >
            <MicOff size={17} />
            <span>设置禁言</span>
            <ChevronRight size={14} className={cn('avatar-context-menu-caret')} />
          </button>
          {muteOpen ? (
            <div className={cn('avatar-context-submenu')}>
              {MUTE_DURATIONS.map((item) => (
                <button
                  key={item.seconds}
                  type="button"
                  disabled={moderationDisabled}
                  onClick={() => onMute(state.sender, item.seconds)}
                >
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {showSetAdmin && onToggleAdmin ? (
        <button
          type="button"
          title={moderationBlockedReason ?? '设为管理员'}
          disabled={moderationDisabled}
          onClick={() => onToggleAdmin(state.sender, true)}
        >
          <ShieldPlus size={17} />
          <span>设为管理员</span>
        </button>
      ) : null}
      {showUnsetAdmin && onToggleAdmin ? (
        <button
          type="button"
          title={moderationBlockedReason ?? '取消管理员'}
          disabled={moderationDisabled}
          onClick={() => onToggleAdmin(state.sender, false)}
        >
          <ShieldMinus size={17} />
          <span>取消管理员</span>
        </button>
      ) : null}
    </div>
  );
}
