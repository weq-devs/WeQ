/**
 * 导出 / 分析选择器共用的小头像：群头像走群号拼 CDN，走缓存协议；
 * 失败时回落成群组图标而不是昵称首字，视觉上更容易一眼分清会话类型。
 */

import { useState, type ReactElement } from 'react';
import { Users } from 'lucide-react';
import { avatarFromGroupCode } from '../lib/avatarResolver';
import { cachedAvatarUrl } from '../lib/avatarCache';

export function GroupAvatar({
  code,
  size = 34,
  className = '',
}: {
  code: string;
  size?: number;
  className?: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const url = cachedAvatarUrl(avatarFromGroupCode(code, size >= 64 ? 100 : 0));
  if (!url || failed)
    return (
      <span
        className={`weq-avatar-fallback ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        <Users size={Math.round(size * 0.5)} strokeWidth={1.7} />
      </span>
    );
  return (
    <img
      className={`weq-avatar-img ${className}`}
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
