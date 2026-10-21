/**
 * 会话列表里的虚拟会话头像 / 徽标。
 *
 * - 克隆体：沿用源好友头像，右下角叠一个「对话气泡 + 星」的小角标，和 QQ 官方
 *   机器人的 Bot 图标区分开。
 * - 克隆群：用成员头像拼合成头像（布局见 GroupMosaicAvatar，2/3/4 人都能铺满），
 *   右下角叠「群聊」角标 —— 一眼能看出这是「一群人」而不是单个克隆体。
 *
 * 所有颜色走 design token，深浅模式各有一套值。
 */

import { useState, type ReactElement } from 'react';
import { MessagesSquare, Sparkles, Users } from 'lucide-react';
import type { VirtualConversation } from '../lib/conversationDirectory';
import { GroupMosaicAvatar } from './GroupMosaicAvatar';
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

/** 合成头像：布局交给 GroupMosaicAvatar，会话列表 / 克隆工作区 / 导出共用一套拼格。 */
function GridAvatar({ uins, size }: { uins: readonly string[]; size: number }): ReactElement {
  return <GroupMosaicAvatar uins={uins} size={size} />;
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
