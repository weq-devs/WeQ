import { useContext, type RefObject } from 'react';
import type { Message } from '../im-template/template/types';
import { localDressApplies } from '../lib/dressSkin';
import { MsgDecorationEnabledContext } from '../state/messageAppearance';
import { useActiveFontFx, useActiveWidget } from './useActiveWidget.shared';
import { useBubbleFontFx } from './useBubbleFontFx';
import { useMsgDecoration } from './useMsgDecoration';

export function useMessageRowDress(
  decoration: Message['decoration'],
  bubbleRef: RefObject<HTMLElement | null>,
  {
    mine,
    pending = false,
    fallbackPendant,
  }: {
    mine: boolean;
    pending?: boolean;
    fallbackPendant?: string;
  },
) {
  const enabled = useContext(MsgDecorationEnabledContext);
  const { widget, scope, scopes, fontActive, bubbleActive } = useActiveWidget();
  const activeFontFx = useActiveFontFx();
  const recordWidget = Boolean(decoration?.widgetId || (mine && fallbackPendant));
  const localFont =
    fontActive && localDressApplies(scopes?.font ?? scope, mine, Boolean(decoration?.fontId));
  const localBubble =
    bubbleActive && localDressApplies(scopes?.bubble ?? scope, mine, Boolean(decoration?.bubbleId));
  const localWidget = widget && localDressApplies(scope, mine, recordWidget) ? widget : null;
  const resolved = useMsgDecoration(
    decoration
      ? {
          ...decoration,
          fontId: localFont ? 0 : decoration.fontId,
          bubbleId: localBubble ? 0 : decoration.bubbleId,
          widgetId: localWidget ? 0 : decoration.widgetId,
        }
      : undefined,
    bubbleRef,
    pending,
  );
  const fontFxAttr = useBubbleFontFx(localFont ? activeFontFx : resolved.fontFx, bubbleRef);
  const lineWidget = enabled.widget ? (localWidget ?? resolved.widget) : null;
  return {
    bubbleId: resolved.bubbleId,
    fontId: resolved.fontId,
    dressed: Boolean(resolved.bubbleId || localBubble),
    widget: lineWidget,
    fallbackPendant: mine && enabled.widget ? fallbackPendant : undefined,
    attributes: {
      'data-bubble': resolved.bubbleId || undefined,
      'data-weq-message-image-pending': resolved.imagePending || undefined,
      'data-font': resolved.fontId || undefined,
      'data-weq-system-font': resolved.systemFont || undefined,
      'data-record-bubble': decoration?.bubbleId || undefined,
      'data-record-font': decoration?.fontId || undefined,
      'data-record-widget': recordWidget || undefined,
      'data-fontfx': fontFxAttr,
      'data-widget': lineWidget?.animated ? lineWidget.itemId : undefined,
    },
  };
}
