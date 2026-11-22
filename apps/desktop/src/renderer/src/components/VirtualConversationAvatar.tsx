/**
 * 会话列表里的虚拟会话头像 / 徽标。
 *
 * - 克隆体：沿用源好友头像，右下角叠与克隆导航一致的身份角标。
 * - 克隆群：用成员头像拼合成头像（布局见 GroupMosaicAvatar，2/3/4 人都能铺满），
 *   右下角叠「群聊」角标 —— 一眼能看出这是「一群人」而不是单个克隆体。
 *
 * 所有颜色走 design token，深浅模式各有一套值。
 */

import type { ReactElement } from 'react';
import { Users } from 'lucide-react';
import { FEATURE_ICONS } from '../lib/featureIcons.shared';
import type { VirtualConversation } from '../lib/conversationDirectory';
import { GroupMosaicAvatar } from './GroupMosaicAvatar';
import { qqAvatarUrl } from './QqAvatar.shared';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import { useAvatarImage } from '../hooks/useAvatarImage';
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
  const image = useAvatarImage(src);
  if (!src || image.failed)
    return (
      <span
        ref={image.observeRef}
        className={`weq-virtual-avatar-fallback ${className}`}
        aria-hidden
      >
        <Users size={Math.round(size * 0.55)} strokeWidth={1.7} />
      </span>
    );
  return (
    <img
      key={image.retryKey}
      className={className}
      ref={image.ref}
      src={image.src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onLoad={image.onLoad}
      onError={image.onError}
    />
  );
}

/** 合成头像：布局交给 GroupMosaicAvatar，会话列表 / 克隆工作区 / 导出共用一套拼格。 */
function GridAvatar({
  uins,
  size,
}: {
  uins: readonly string[];
  size: number | string;
}): ReactElement {
  return <GroupMosaicAvatar uins={uins} size={size} />;
}

/** 会话列表与消息头像共用克隆角标。 */
export function VirtualConversationBadge({ group = false }: { group?: boolean }) {
  return (
    <span
      className="weq-virtual-avatar-badge"
      title={group ? '克隆群聊' : '克隆体'}
      aria-label={group ? '克隆群聊' : '克隆体'}
    >
      {group ? (
        <FEATURE_ICONS.cloneGroup size={10} strokeWidth={2.4} aria-hidden />
      ) : (
        <FEATURE_ICONS.clone size={10} strokeWidth={2.4} aria-hidden />
      )}
    </span>
  );
}

export function VirtualConversationAvatar({
  item,
  size,
}: {
  item: VirtualConversation;
  size?: number;
}): ReactElement {
  const isGroup = item.kind === 'group';
  const memberUins = item.memberUins ?? [];
  return (
    <span
      className={`avatar weq-virtual-avatar is-${item.kind}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {isGroup && memberUins.length > 0 ? (
        <GridAvatar uins={memberUins} size={size ?? '100%'} />
      ) : item.uin ? (
        <AvatarImg uin={item.uin} size={size ?? 44} />
      ) : (
        <span className="weq-virtual-avatar-fallback">
          <Users size={Math.round((size ?? 44) * 0.5)} strokeWidth={1.7} />
        </span>
      )}
      <VirtualConversationBadge group={isGroup} />
    </span>
  );
}
