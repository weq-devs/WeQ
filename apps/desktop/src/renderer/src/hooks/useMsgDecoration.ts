/**
 * Per-message decoration hook.
 *
 * Given the raw decoration ids from DB column 40801, fetches resolved data via
 * tRPC (staleTime=Infinity — same id never re-fetches) and injects CSS side
 * effects when the data arrives. Returns the resolved widget/pendant overlay
 * for inline rendering.
 */

import { useContext, useEffect } from 'react';
import type { ResolvedWidget } from '@weq/service';
import { trpc } from '../trpc/client';
import { MsgDecorationEnabledContext } from '../components/QqMessageContent';
import { injectBubbleCss, injectFontCss, injectWidgetCss } from '../lib/msgDecorationStyle';
import { toFontFxSkin, type FontFxSkin } from '../lib/dressSkin';

type DecorationIds = { bubbleId: number; fontId: number; widgetId: number } | undefined;

/**
 * Async per-message decoration. Returns the resolved widget overlay (or null).
 *
 * The hook is cheap when decoration is absent or the feature is disabled:
 * the tRPC query is gated by `enabled` so no requests fire.
 *
 * CSS for bubbles / fonts / animated widgets is injected as a side-effect when
 * data arrives; the caller only needs to apply `data-bubble` / `data-font` /
 * `data-widget` attributes to the DOM.
 *
 * 字体多回一份 `fontFx`（`eimg` 炫彩帧）：那层 CSS 要求行上再挂一个
 * `data-fontfx="<字体id>-<变体>"` 才生效，而挂哪一档要量完气泡尺寸才知道（气泡比
 * 动画画布还大就不放）——量尺寸是每个气泡自己的事，所以数据交给调用方。
 */
export function useMsgDecoration(decoration: DecorationIds): {
  widget: ResolvedWidget | null;
  bubbleId: number;
  fontId: number;
  /** 这款字体的炫彩帧素材（没字体 / 没有 `eimg` 时 null）——气泡按尺寸决定挂不挂。 */
  fontFx: FontFxSkin | null;
} {
  const enabled = useContext(MsgDecorationEnabledContext);
  const hasDec = Boolean(
    decoration && (decoration.bubbleId || decoration.fontId || decoration.widgetId),
  );

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
    if (result.data.font && decoration?.fontId) {
      injectFontCss(decoration.fontId, result.data.font);
    }
    if (result.data.widget) injectWidgetCss(result.data.widget);
  }, [result.data, decoration?.fontId]);

  if (!enabled || !hasDec) return { widget: null, bubbleId: 0, fontId: 0, fontFx: null };
  const font = result.data?.font ?? null;
  return {
    widget: result.data?.widget ?? null,
    bubbleId: result.data?.bubble ? (decoration?.bubbleId ?? 0) : 0,
    fontId: font ? (decoration?.fontId ?? 0) : 0,
    fontFx: toFontFxSkin(font),
  };
}
