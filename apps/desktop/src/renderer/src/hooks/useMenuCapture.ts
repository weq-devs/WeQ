import { useCallback, useEffect, useRef } from 'react';

export const MENU_CAPTURE_HOVER_MS = 1000;

/** 隐藏菜单时保留原布局和命中区域，避免按钮挪动造成反复进出。 */
export function useMenuCapture(capture: () => Promise<void>) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layer = useRef<HTMLElement | null>(null);
  const preview = useRef(false);
  const capturing = useRef(false);

  const findLayer = useCallback(
    () =>
      buttonRef.current
        ?.closest('.weq-workspace-menu')
        ?.closest<HTMLElement>('.weq-dialog-layer') ?? null,
    [],
  );

  const syncVisibility = useCallback(() => {
    const element = layer.current;
    if (!element) return;
    if (capturing.current) element.dataset.menuCapture = 'capturing';
    else if (preview.current) element.dataset.menuCapture = 'preview';
    else element.removeAttribute('data-menu-capture');
  }, []);

  const cancelTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const restoreMenu = useCallback(() => {
    cancelTimer();
    preview.current = false;
    syncVisibility();
  }, [cancelTimer, syncVisibility]);

  useEffect(() => {
    const view = buttonRef.current?.ownerDocument.defaultView;
    layer.current = findLayer();
    const observer = new MutationObserver(() => {
      if (layer.current?.hidden) restoreMenu();
    });
    if (layer.current)
      observer.observe(layer.current, { attributes: true, attributeFilter: ['hidden'] });
    view?.addEventListener('blur', restoreMenu);
    return () => {
      observer.disconnect();
      view?.removeEventListener('blur', restoreMenu);
      cancelTimer();
      layer.current?.removeAttribute('data-menu-capture');
      layer.current = null;
    };
  }, [cancelTimer, findLayer, restoreMenu]);

  return {
    ref: buttonRef,
    onPointerEnter: () => {
      cancelTimer();
      layer.current = findLayer();
      timer.current = setTimeout(() => {
        timer.current = null;
        preview.current = true;
        syncVisibility();
      }, MENU_CAPTURE_HOVER_MS);
    },
    onPointerLeave: restoreMenu,
    onPointerCancel: restoreMenu,
    onClick: async () => {
      if (capturing.current) return;
      layer.current = findLayer();
      capturing.current = true;
      syncVisibility();
      try {
        // 跨过一次完整绘制，确保 IPC 捕获的是按钮已隐藏后的合成帧。
        const view = buttonRef.current?.ownerDocument.defaultView;
        if (view) {
          await new Promise<void>((resolve) =>
            view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())),
          );
        }
        if (buttonRef.current?.isConnected && !layer.current?.hidden) await capture();
      } finally {
        capturing.current = false;
        syncVisibility();
      }
    },
  };
}
