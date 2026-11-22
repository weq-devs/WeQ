/**
 * QQ avatar with graceful fallback to a user glyph. Resolves the public CDN
 * URL from a uin when no explicit URL is given.
 */

import type { ReactElement } from 'react';
import { UserRound } from 'lucide-react';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import { useAvatarImage } from '../hooks/useAvatarImage';
import { useRenderDocument, resourceForRenderDocument } from '../lib/renderDocument';
import { qqAvatarUrl } from './QqAvatar.shared';

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
  const ownerDocument = useRenderDocument();
  const raw = useAvatarUrl(
    url || (uin ? qqAvatarUrl(uin) : null),
    true,
    size <= 64 ? 'small' : 'big',
    uin,
  );
  const resolved = raw ? resourceForRenderDocument(raw, ownerDocument) : raw;
  const image = useAvatarImage(resolved, { uin });
  if (!resolved || image.failed) {
    return (
      <span
        ref={image.observeRef}
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
      key={image.retryKey}
      ref={image.ref}
      src={image.src}
      alt=""
      width={size}
      height={size}
      className={`weq-avatar-img ${className}${image.loaded ? '' : ' is-pending'}`}
      style={{ width: size, height: size }}
      onLoad={image.onLoad}
      onError={image.onError}
    />
  );
}
