/**
 * Overlay stacking — hand out z-index values in open order so the LAST opened
 * overlay always wins, instead of every layer hard-coding a number in CSS.
 *
 * Fixed CSS z-index breaks any combination the author didn't anticipate: a
 * lightbox (120) opened from inside a modal (140) renders behind the modal that
 * spawned it. Layers that opt into this hook get a monotonically increasing
 * value instead, so nesting works in any order.
 *
 * The CSS numbers stay as the floor: BASE sits above all of them, so an
 * opted-in layer never falls below a layer that still uses static CSS.
 */

import { createContext, useContext, useRef } from 'react';

/** Portal 保留 React 上下文：子浮层始终高于所属父窗的最新层级。 */
export const OverlayLayerContext = createContext<number | undefined>(undefined);

/** Above every static overlay in CSS (highest is .weq-ra-layer at 1200), but
 *  below the toast host (4000), which must stay on top of everything. */
const BASE = 1200;
let counter = BASE;

export function claimOverlayLayer(): number {
  return ++counter;
}

/** 底层页面快捷键不能穿透工具遮罩；保留但隐藏的工具不算活动对话框。 */
export function hasActiveModal(
  ownerDocument: Document | undefined = typeof document === 'undefined' ? undefined : document,
): boolean {
  return (
    Boolean(ownerDocument) &&
    [...(ownerDocument?.querySelectorAll('[aria-modal="true"]') ?? [])].some(
      (element) => !element.closest('[hidden], [inert]'),
    )
  );
}

/**
 * Claim a z-index for a layer while `active`. Claimed once per open; reopening
 * claims a fresh (higher) value. Returns undefined when inactive so callers can
 * fall back to their CSS value.
 */
export function useOverlayLayer(active: boolean, revision = 0): number | undefined {
  const parentLayer = useContext(OverlayLayerContext);
  const claimed = useRef<number | undefined>(undefined);
  const previousRevision = useRef(revision);
  if (
    active &&
    (claimed.current === undefined ||
      revision !== previousRevision.current ||
      (parentLayer !== undefined && claimed.current <= parentLayer))
  )
    claimed.current = claimOverlayLayer();
  else if (!active && claimed.current !== undefined) claimed.current = undefined;
  previousRevision.current = revision;
  return claimed.current;
}
