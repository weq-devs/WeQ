/**
 * QQ avatar with graceful fallback to a user glyph. Resolves the public CDN
 * URL from a uin when no explicit URL is given.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { UserRound } from 'lucide-react';

export function qqAvatarUrl(uin: string): string {
  return `https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0`;
}

export function QqAvatar({
  uin,
  url,
  size = 40,
  className = '',
}: {
  uin?: string | null;
  url?: string | null;
  size?: number;
  className?: string;
}): ReactElement {
  const resolved = url || (uin ? qqAvatarUrl(uin) : null);
  const [failed, setFailed] = useState(false);

  // Reset the failure flag when the source changes (account switch).
  useEffect(() => setFailed(false), [resolved]);

  if (!resolved || failed) {
    return (
      <span
        className={`weq-avatar-fallback ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        <UserRound size={Math.round(size * 0.5)} strokeWidth={1.75} />
      </span>
    );
  }

  return (
    <img
      src={resolved}
      alt=""
      width={size}
      height={size}
      className={`weq-avatar-img ${className}`}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
