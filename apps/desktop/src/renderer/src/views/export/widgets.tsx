/**
 * Small shared presentational widgets for the export hub. Visual language
 * follows the rest of weq: #0099ff accent, thin borders, small radii.
 */

import type { ReactElement } from 'react';
import { Loader2 } from 'lucide-react';
import { AvatarPicture } from '../../components/AvatarPicture';

/** Spinning loader glyph at a given pixel size. */
export function Spinner({ size = 16 }: { size?: number }): ReactElement {
  return <Loader2 size={size} className="weq-exp-spin" strokeWidth={2} aria-hidden />;
}

export function Avatar({
  url,
  group,
  size = 36,
}: {
  url: string | null | undefined;
  group?: boolean;
  size?: number;
}): ReactElement {
  return (
    <AvatarPicture
      className="weq-exp-avatar"
      src={url}
      group={group}
      style={{ width: size, height: size }}
    />
  );
}
