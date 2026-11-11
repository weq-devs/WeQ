import { OverlayLayer, type OverlayLayerProps } from './OverlayLayer';

/** 同一份功能内容可由资料页或原有独立浮层承载。 */
export function ProfileDetailSurface({
  embedded,
  ...props
}: OverlayLayerProps & { embedded?: boolean }) {
  return embedded ? (
    <div className="weq-profile-detail-embedded">{props.children}</div>
  ) : (
    <OverlayLayer {...props} />
  );
}
