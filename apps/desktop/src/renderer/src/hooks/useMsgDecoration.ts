/**
 * Per-message decoration hook.
 *
 * Given the raw decoration ids from DB column 40801, fetches resolved data via
 * tRPC (staleTime=Infinity — same id never re-fetches) and injects CSS side
 * effects when the data arrives. Returns the resolved widget/pendant overlay
 * for inline rendering.
 */

import { useContext, useLayoutEffect, useState, type RefObject } from 'react';
import type { ResolvedWidget } from '@weq/service';
import { trpc } from '../trpc/client';
import { MsgDecorationEnabledContext } from '../components/QqMessageContent';
import { injectBubbleCss, injectFontCss, injectWidgetCss } from '../lib/msgDecorationStyle';
import { toFontFxSkin, type FontFxSkin } from '../lib/dressSkin';
import { useTabActive } from '../components/RetainedTabs';

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
 * 气泡与字体的返回 id 经过资源就绪检查：同条消息的两项装扮一起应用或一起回退。
 *
 * 字体多回一份 `fontFx`（`eimg` 炫彩帧）：那层 CSS 要求行上再挂一个
 * `data-fontfx="<字体id>-<变体>"` 才生效，而挂哪一档要量完气泡尺寸才知道（气泡比
 * 动画画布还大就不放）——量尺寸是每个气泡自己的事，所以数据交给调用方。
 */
export function useMsgDecoration(
  decoration: DecorationIds,
  element?: RefObject<HTMLElement | null>,
): {
  widget: ResolvedWidget | null;
  bubbleId: number;
  fontId: number;
  /** 这款字体的炫彩帧素材（没字体 / 没有 `eimg` 时 null）——气泡按尺寸决定挂不挂。 */
  fontFx: FontFxSkin | null;
} {
  const enabled = useContext(MsgDecorationEnabledContext);
  const tabActive = useTabActive();
  const [visible, setVisible] = useState(!element || typeof IntersectionObserver === 'undefined');
  useLayoutEffect(() => {
    const node = element?.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    // 新记录接替发送预览时，不能等异步可见性回调才恢复已缓存的字体与气泡。
    const rect = node.getBoundingClientRect();
    if (rect.width || rect.height)
      setVisible(rect.bottom >= -200 && rect.top <= window.innerHeight + 200);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      {
        rootMargin: '200px',
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);
  const bubbleId = enabled.bubble ? (decoration?.bubbleId ?? 0) : 0;
  const fontId = enabled.font ? (decoration?.fontId ?? 0) : 0;
  const widgetId = enabled.widget ? (decoration?.widgetId ?? 0) : 0;
  // 按种类共享缓存，挂件不影响字体与气泡的就绪状态。
  const bubbleQuery = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { bubbleId, fontId: 0, widgetId: 0 },
    { enabled: Boolean(bubbleId && visible && tabActive), staleTime: Infinity },
  );
  const fontQuery = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { bubbleId: 0, fontId, widgetId: 0 },
    { enabled: Boolean(fontId && visible && tabActive), staleTime: Infinity },
  );
  const widgetQuery = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { bubbleId: 0, fontId: 0, widgetId },
    { enabled: Boolean(widgetId && visible && tabActive), staleTime: Infinity },
  );
  const bubble = bubbleId ? (bubbleQuery.data?.bubble ?? null) : null;
  const font = fontId ? (fontQuery.data?.font ?? null) : null;
  const widget = widgetId ? (widgetQuery.data?.widget ?? null) : null;

  const [prepared, setPrepared] = useState<{
    bubble: typeof bubble;
    font: typeof font;
    bubbleId: number;
    fontId: number;
  } | null>(null);
  useLayoutEffect(() => {
    // 配置返回不代表资源可绘制；成组等待底图解码和字体注册，避免半套装扮降低对比度。
    if (
      !visible ||
      !tabActive ||
      (!bubbleId && !fontId) ||
      (bubbleId && !bubble) ||
      (fontId && !font)
    )
      return;
    const bubbleLease = bubble ? injectBubbleCss(bubble) : null;
    const fontLease = font ? injectFontCss(fontId, font) : null;
    let disposed = false;
    void Promise.all([bubbleLease?.ready ?? true, fontLease?.ready ?? true]).then((results) => {
      if (!disposed && results.every(Boolean)) setPrepared({ bubble, font, bubbleId, fontId });
    });
    return () => {
      disposed = true;
      setPrepared(null);
      bubbleLease?.();
      fontLease?.();
    };
  }, [bubble, font, bubbleId, fontId, visible, tabActive]);
  useLayoutEffect(() => {
    if (visible && tabActive && widget) return injectWidgetCss(widget);
  }, [widget, visible, tabActive]);

  const ready =
    visible &&
    tabActive &&
    prepared?.bubble === bubble &&
    prepared?.font === font &&
    prepared?.bubbleId === bubbleId &&
    prepared?.fontId === fontId;
  return {
    widget,
    bubbleId: ready ? bubbleId : 0,
    fontId: ready ? fontId : 0,
    fontFx: ready ? toFontFxSkin(font) : null,
  };
}
