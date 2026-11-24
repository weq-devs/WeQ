import type { ComponentPropsWithoutRef } from 'react';
import { UserRound, UsersRound } from 'lucide-react';
import { useAvatarImage } from '../hooks/useAvatarImage';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import { resourceForRenderDocument, useRenderDocument } from '../lib/renderDocument';
import '../styles/avatar-picture.css';

type FrameProps = Omit<ComponentPropsWithoutRef<'span'>, 'children'> & {
  group?: boolean;
  label?: string;
  eager?: boolean;
};

export function AvatarPicture({ src, ...frame }: FrameProps & { src?: string | null }) {
  const document = useRenderDocument();
  const url = useAvatarUrl(src);
  const source = url ? resourceForRenderDocument(url, document) : url;
  const image = useAvatarImage(source);
  return <AvatarPictureFrame {...frame} source={source} image={image} />;
}

export function AvatarPictureFrame({
  source,
  image,
  previous,
  className,
  group,
  label,
  eager,
  ...props
}: FrameProps & {
  source?: string | null;
  image: ReturnType<typeof useAvatarImage>;
  previous?: { src: string; retryKey?: string };
}) {
  const src = image.src;
  const key = image.retryKey ? `retry:${image.retryKey}` : src;
  const ready = Boolean(image.loaded && !image.failed && src);
  const previousKey =
    !ready && previous
      ? previous.retryKey
        ? `retry:${previous.retryKey}`
        : previous.src
      : undefined;
  const current = source && !image.failed && src && key ? { src, key } : undefined;
  const fallback = !previousKey && (!source || image.failed);
  const Icon = group ? UsersRound : UserRound;

  return (
    <span
      {...props}
      className={`weq-avatar-picture${className ? ` ${className}` : ''}`}
      ref={image.observeRef}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-avatar-fallback={fallback || undefined}
    >
      {fallback && <Icon className="weq-avatar-picture-glyph" aria-hidden />}
      {/* Keep the loaded DOM image mounted while the replacement is still pending. */}
      {[
        current,
        previous && previousKey && previousKey !== current?.key
          ? { src: previous.src, key: previousKey }
          : undefined,
      ].map((face) => {
        if (!face) return null;
        const active = face === current;
        return (
          <img
            key={face.key}
            className="weq-avatar-picture-image"
            style={
              active && !ready && previousKey !== face.key ? { visibility: 'hidden' } : undefined
            }
            src={face.src}
            alt=""
            draggable={false}
            loading={eager ? 'eager' : 'lazy'}
            referrerPolicy="no-referrer"
            ref={active ? image.ref : undefined}
            onLoad={active ? image.onLoad : undefined}
            onError={active ? image.onError : undefined}
          />
        );
      })}
    </span>
  );
}
