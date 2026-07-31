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

import { useRef } from 'react';

/** Above every static overlay in CSS (highest is .weq-ra-layer at 1200), but
 *  below the toast host (4000), which must stay on top of everything. */
const BASE = 1200;
let counter = BASE;

/**
 * Claim a z-index for a layer while `active`. Claimed once per open; reopening
 * claims a fresh (higher) value. Returns undefined when inactive so callers can
 * fall back to their CSS value.
 */
export function useOverlayLayer(active: boolean): number | undefined {
  const claimed = useRef<number | undefined>(undefined);
  if (active && claimed.current === undefined) claimed.current = ++counter;
  else if (!active && claimed.current !== undefined) claimed.current = undefined;
  return claimed.current;
}
