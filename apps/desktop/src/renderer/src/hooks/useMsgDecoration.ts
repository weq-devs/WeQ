/**
 * Per-message decoration hook.
 *
 * Given the raw decoration ids from DB column 40801, fetches resolved data via
 * tRPC (staleTime=Infinity — same id never re-fetches) and injects CSS side
 * effects when the data arrives. Returns the resolved widget/pendant overlay
 * for inline rendering.
 */

import { useContext, useInsertionEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { ResolvedWidget, MessageBubbleSkin } from '@weq/service';
import { trpc } from '../trpc/client';
import { MsgDecorationEnabledContext } from '../state/messageAppearance';
import {
  injectBubbleCss,
  injectFontCss,
  injectWidgetCss,
  isMessageFontLoaded,
} from '../lib/msgDecorationStyle';
import { toFontFxSkin, type FontFxSkin } from '../lib/dressSkin';
import { useTabActive } from '../components/RetainedTabs.shared';
import { messageBubble } from '../lib/messageBubbles';
import { MessageImageContext } from '../lib/messageImageContext';

type DecorationIds =
  | {
      bubbleId: number;
      fontId: number;
      widgetId: number;
      fontId1Raw?: number;
      fontId2Raw?: number;
      cachedBubble?: MessageBubbleSkin;
    }
  | undefined;

/**
 * Async per-message decoration. Returns the resolved widget overlay (or null).
 *
 * The hook is cheap when decoration is absent or the feature is disabled:
 * the tRPC query is gated by `enabled` so no requests fire.
 *
 * CSS for bubbles / fonts / animated widgets is injected as a side-effect when
 * data arrives; the caller only needs to apply `data-bubble` / `data-font` /
 * `data-widget` attributes to the DOM.
 * 本地底图随消息页到达，首次提交直接应用；不隐藏正文，不等待查询或解码。
 *
 * 字体多回一份 `fontFx`（`eimg` 炫彩帧）：那层 CSS 要求行上再挂一个
 * `data-fontfx="<字体id>-<变体>"` 才生效，而挂哪一档要量完气泡尺寸才知道（气泡比
 * 动画画布还大就不放）——量尺寸是每个气泡自己的事，所以数据交给调用方。
 */
export function useMsgDecoration(
  decoration: DecorationIds,
  element?: RefObject<HTMLElement | null>,
  outgoing = false,
): {
  widget: ResolvedWidget | null;
  bubbleId: number;
  fontId: number;
  systemFont: boolean;
  /** 这款字体的炫彩帧素材（没字体 / 没有 `eimg` 时 null）——气泡按尺寸决定挂不挂。 */
  fontFx: FontFxSkin | null;
  imagePending: boolean;
} {
  const enabled = useContext(MsgDecorationEnabledContext);
  const image = useContext(MessageImageContext);
  const tabActive = useTabActive() || image;
  const bubbleId = enabled.bubble ? (decoration?.bubbleId ?? 0) : 0;
  const fontId = enabled.font ? (decoration?.fontId ?? 0) : 0;
  const widgetId = enabled.widget ? (decoration?.widgetId ?? 0) : 0;
  const localBubble = bubbleId
    ? decoration?.cachedBubble?.itemId === bubbleId
      ? decoration.cachedBubble
      : messageBubble(bubbleId)
    : undefined;
  const needsVisibility = Boolean(
    fontId || widgetId || (bubbleId && !localBubble) || localBubble?.animationFrameCount,
  );
  const [inViewport, setVisible] = useState(
    !needsVisibility || !element || typeof IntersectionObserver === 'undefined',
  );
  const visible = image || inViewport;
  useLayoutEffect(() => {
    if (image || !needsVisibility) return;
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
  }, [element, image, needsVisibility]);
  // 按种类共享缓存，挂件不影响字体与气泡的就绪状态。
  const bubbleQuery = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { bubbleId, fontId: 0, widgetId: 0 },
    {
      enabled: Boolean(bubbleId && visible && tabActive && !localBubble),
      staleTime: Infinity,
    },
  );
  const fontQuery = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { bubbleId: 0, fontId, widgetId: 0 },
    { enabled: Boolean(fontId && visible && tabActive), staleTime: Infinity },
  );
  const widgetQuery = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { bubbleId: 0, fontId: 0, widgetId },
    { enabled: Boolean(widgetId && visible && tabActive), staleTime: Infinity },
  );
  const bubble: MessageBubbleSkin | null = bubbleId
    ? (localBubble ?? bubbleQuery.data?.bubble ?? null)
    : null;
  const font = fontId ? (fontQuery.data?.font ?? null) : null;
  // 同款已解码时首轮渲染直接使用；不可见性回调只控制冷加载，不能让缓存字体闪回默认。
  const reusableFont = Boolean(font && isMessageFontLoaded(fontId, font));
  const prepareFont = visible || reusableFont;
  const widget = widgetId ? (widgetQuery.data?.widget ?? null) : null;

  const [failedBubble, setFailedBubble] = useState<typeof bubble>(null);
  const [settledImageBubble, setSettledImageBubble] = useState<typeof bubble>(null);
  const [preparedFont, setPreparedFont] = useState<{
    font: typeof font;
    id: number;
    ok: boolean;
  } | null>(null);
  useInsertionEffect(() => {
    if (!bubble) return;
    const lease = injectBubbleCss(bubble, true);
    let disposed = false;
    void lease.ready.then((ok) => {
      if (disposed) return;
      // 预解码预算/取消不代表内联底图不可绘制，不能据此把缓存气泡改回默认。
      if (!ok && !bubble.baseImage) setFailedBubble(bubble);
      if (image) setSettledImageBubble(bubble);
    });
    return () => {
      disposed = true;
      lease();
    };
  }, [bubble, image]);
  useLayoutEffect(() => {
    if (!visible || !tabActive || !bubble?.animationFrameCount) return;
    return injectBubbleCss(bubble);
  }, [bubble, visible, tabActive]);
  useLayoutEffect(() => {
    if (!prepareFont || !tabActive || !font || !fontId) return;
    const lease = injectFontCss(fontId, font, true);
    let disposed = false;
    void lease.ready.then((ok) => {
      if (!disposed && (ok || image)) setPreparedFont({ font, id: fontId, ok });
    });
    return () => {
      disposed = true;
      setPreparedFont(null);
      lease();
    };
  }, [font, fontId, image, prepareFont, tabActive]);
  useLayoutEffect(() => {
    if (visible && tabActive && font?.fx && fontId) return injectFontCss(fontId, font);
  }, [font, fontId, visible, tabActive]);
  useLayoutEffect(() => {
    if (visible && tabActive && widget) return injectWidgetCss(widget);
  }, [widget, visible, tabActive]);

  const bubbleReady = Boolean(bubble && failedBubble !== bubble);
  const finishedFont = preparedFont?.font === font && preparedFont?.id === fontId;
  const fontReady = Boolean(
    tabActive &&
      font &&
      (reusableFont || (finishedFont && preparedFont.ok)) &&
      (!bubbleId || bubbleReady || (outgoing && reusableFont)),
  );
  // 仅确认是 packed 字体槽生效时读 Android 的高位类型，不按 TTF 文件后缀猜测。
  const packedFontType = ((decoration?.fontId2Raw ?? 0) >>> 16) & 0xf;
  return {
    widget,
    bubbleId: bubbleReady ? bubbleId : 0,
    fontId: fontReady ? fontId : 0,
    systemFont: fontReady && !decoration?.fontId1Raw && packedFontType === 2,
    fontFx: fontReady ? toFontFxSkin(font) : null,
    imagePending:
      image &&
      (bubbleQuery.isFetching ||
        fontQuery.isFetching ||
        widgetQuery.isFetching ||
        Boolean(bubble && bubble !== settledImageBubble) ||
        Boolean(font && !reusableFont && !finishedFont)),
  };
}
