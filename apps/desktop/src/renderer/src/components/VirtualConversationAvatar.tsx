/**
 * 会话列表里的虚拟会话头像 / 徽标。
 *
 * - 克隆体：沿用源好友头像，右下角叠一个「对话气泡 + 星」的小角标，和 QQ 官方
 *   机器人的 Bot 图标区分开。
 * - 克隆群：用成员头像拼九宫格（最多 9 格，少于 4 人用 2×2、少于 2 人单图），
 *   右下角叠「群聊」角标 —— 一眼能看出这是「一群人」而不是单个克隆体。
 *
 * 所有颜色走 design token，深浅模式各有一套值。
 */

import { useState, type ReactElement } from 'react';
import { MessagesSquare, Sparkles, Users } from 'lucide-react';
import type { VirtualConversation } from '../lib/conversationDirectory';
import { qqAvatarUrl } from './QqAvatar';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import '../styles/virtual-conversation.css';

function AvatarImg({
  uin,
  size,
  className = '',
}: {
  uin: string;
  size: number;
  className?: string;
}): ReactElement {
  const src = useAvatarUrl(qqAvatarUrl(uin));
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <span
        className={`weq-virtual-avatar-fallback ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        <Users size={Math.round(size * 0.55)} strokeWidth={1.7} />
      </span>
    );
  return (
    <img
      className={className}
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** 九宫格合成头像：2×2 以下用更少格子，避免小图里出现一堆空白。 */
function GridAvatar({ uins, size }: { uins: readonly string[]; size: number }): ReactElement {
  const unique = [...new Set(uins.filter(Boolean))].slice(0, 9);
  if (unique.length === 0)
    return (
      <span className="weq-virtual-avatar-fallback" style={{ width: size, height: size }}>
        <Users size={Math.round(size * 0.5)} strokeWidth={1.7} />
      </span>
    );
  const columns = unique.length >= 5 ? 3 : unique.length >= 2 ? 2 : 1;
  const rows = Math.min(3, Math.ceil(unique.length / columns));
  return (
    <span
      className="weq-virtual-avatar-grid"
      style={{
        width: size,
        height: size,
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
      aria-hidden
    >
      {unique.slice(0, columns * rows).map((uin) => (
        <AvatarImg key={uin} uin={uin} size={size} />
      ))}
    </span>
  );
}

export function VirtualConversationAvatar({
  item,
  size = 44,
}: {
  item: VirtualConversation;
  size?: number;
}): ReactElement {
  const isGroup = item.kind === 'group';
  const memberUins = item.memberUins ?? [];
  return (
    <span
      className={`weq-virtual-avatar is-${item.kind}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {isGroup && memberUins.length > 0 ? (
        <GridAvatar uins={memberUins} size={size} />
      ) : item.uin ? (
        <AvatarImg uin={item.uin} size={size} />
      ) : (
        <span className="weq-virtual-avatar-fallback" style={{ width: size, height: size }}>
          <Users size={Math.round(size * 0.5)} strokeWidth={1.7} />
        </span>
      )}
      <span className="weq-virtual-avatar-badge" title={isGroup ? '克隆群聊' : '克隆体'}>
        {isGroup ? (
          <MessagesSquare size={10} strokeWidth={2.4} />
        ) : (
          <Sparkles size={10} strokeWidth={2.4} />
        )}
      </span>
    </span>
  );
}
