/**
 * Per-message decoration hook.
 *
 * Given the raw decoration ids from DB column 40801, fetches resolved data via
 * tRPC (staleTime=Infinity — same id never re-fetches) and injects CSS side
 * effects when the data arrives. Returns the widget CDN URL for inline rendering.
 */

import { useContext, useEffect } from 'react';
import { trpc } from '../trpc/client';
import { MsgDecorationEnabledContext } from '../components/QqMessageContent';
import { injectBubbleCss, injectFontCss } from '../lib/msgDecorationStyle';

type DecorationIds = { bubbleId: number; fontId: number; widgetId: number } | undefined;

/**
 * Async per-message decoration. Returns the widget overlay URL (or null).
 *
 * The hook is cheap when decoration is absent or the feature is disabled:
 * the tRPC query is gated by `enabled` so no requests fire.
 *
 * CSS for bubbles / fonts is injected as a side-effect when data arrives; the
 * caller only needs to apply `data-bubble` / `data-font` attributes to the DOM.
 */
export function useMsgDecoration(decoration: DecorationIds): {
  widgetUrl: string | null;
  bubbleId: number;
  fontId: number;
} {
  const enabled = useContext(MsgDecorationEnabledContext);
  const hasDec = Boolean(decoration && (decoration.bubbleId || decoration.fontId || decoration.widgetId));

  const result = trpc.account.dressup.resolveMsgDecoration.useQuery(
    {
      bubbleId: decoration?.bubbleId ?? 0,
      fontId: decoration?.fontId ?? 0,
      widgetId: decoration?.widgetId ?? 0,
    },
    {
      enabled: enabled && hasDec,
      staleTime: Infinity,
    },
  );

  useEffect(() => {
    if (!result.data) return;
    if (result.data.bubble) injectBubbleCss(result.data.bubble);
    if (result.data.fontFile && decoration?.fontId) injectFontCss(decoration.fontId);
  }, [result.data, decoration?.fontId]);

  if (!enabled || !hasDec) return { widgetUrl: null, bubbleId: 0, fontId: 0 };
  return {
    widgetUrl: result.data?.widgetUrl ?? null,
    bubbleId: result.data?.bubble ? (decoration?.bubbleId ?? 0) : 0,
    fontId: result.data?.fontFile ? (decoration?.fontId ?? 0) : 0,
  };
}
