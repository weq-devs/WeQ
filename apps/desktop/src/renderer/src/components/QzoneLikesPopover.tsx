import type { ComponentProps } from 'react';
import { HoverPopover } from './HoverPopover';

export function QzoneLikesPopover(props: ComponentProps<typeof HoverPopover>) {
  return <HoverPopover contextMenu {...props} />;
}
