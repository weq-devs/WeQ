import { DressImage } from './DressImage';

export function AvatarPendantImage({
  widget,
  fallbackUrl,
}: {
  widget: { animated: boolean; url?: string } | null;
  fallbackUrl?: string | null;
}) {
  if (widget?.animated) return <span className="weq-avatar-pendant-img" aria-hidden />;
  const src = widget ? widget.url : fallbackUrl;
  return src ? (
    <DressImage
      className="weq-avatar-pendant-img"
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
    />
  ) : null;
}
