import { createElement, type ComponentProps } from 'react';
import { DeferredSurfaceLoading } from './DeferredSurfaceLoading';

type SurfaceProps = ComponentProps<typeof DeferredSurfaceLoading>;
type PanelProps = Pick<SurfaceProps, 'onClose' | 'open' | 'embedded' | 'anchor'>;

export function surfaceLoading(
  title: string,
  options?: Omit<SurfaceProps, keyof PanelProps | 'title'>,
) {
  return ({ onClose, open, embedded, anchor }: PanelProps) =>
    createElement(DeferredSurfaceLoading, { title, onClose, open, embedded, anchor, ...options });
}
