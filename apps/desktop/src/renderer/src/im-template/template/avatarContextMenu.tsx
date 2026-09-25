import { AtSign, Hand } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { User } from './types';
import { cn } from './classNames';

export type AvatarContextMenuState = {
  sender: User;
  x: number;
  y: number;
};

/**
 * 右键消息里某个头像弹出的轻互动菜单：
 *   - 「@他」把 `@昵称 ` 写进输入框（纯前端编辑，不限在线状态）；
 *   - 「戳一戳」走 OIDB 0xED3_1 发包，需要在线且已注入的 QQ —— 不可用时置灰并说明原因。
 */
export function AvatarContextMenu({
  state,
  onMention,
  onPoke,
  pokeBlockedReason,
}: {
  state: AvatarContextMenuState;
  onMention: (sender: User) => void;
  onPoke: (sender: User) => void;
  /** 非空 = 这条会话当前不能戳（QQ 未在线 / 完全离线模式），按钮置灰并显示原因。 */
  pokeBlockedReason?: string | null;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

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
  }, [state.x, state.y]);

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
        <span>@他</span>
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
    </div>
  );
}
