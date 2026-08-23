/**
 * QQ avatar with graceful fallback to a user glyph. Resolves the public CDN
 * URL from a uin when no explicit URL is given.
 */

import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { UserRound } from 'lucide-react';
import { cachedAvatarUrl } from '../lib/avatarCache';

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
  const resolved = cachedAvatarUrl(url || (uin ? qqAvatarUrl(uin) : null));
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Reset the failure/loading flags when the source changes (account switch).
  useLayoutEffect(() => {
    setFailed(false);
    setLoaded(false);
    // 图片已缓存（或 data: 立即完成）时直接显示，避免 shimmer 闪现。
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setLoaded(true);
    }
  }, [resolved]);

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
      ref={imgRef}
      src={resolved}
      alt=""
      width={size}
      height={size}
      className={`weq-avatar-img ${className}${loaded ? '' : ' is-pending'}`}
      style={{ width: size, height: size }}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  );
}
