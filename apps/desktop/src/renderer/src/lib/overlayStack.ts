/**
 * Overlay stacking — hand out z-index values in open order so the LAST opened
 * overlay always wins, instead of every layer hard-coding a number in CSS.
 *
 * Fixed CSS z-index breaks any combination the author didn't anticipate: a
 * lightbox (120) opened from inside a modal (140) renders behind the modal that
 * spawned it. Active layers are ranked in open order and released on close;
 * repeated opens cannot grow their CSS values beyond the notification layer.
 *
 * The CSS numbers stay as the floor: BASE sits above all of them, so an
 * opted-in layer never falls below a layer that still uses static CSS.
 */

import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

/** Portal 保留 React 上下文：子浮层始终高于所属父窗的最新层级。 */
export const OverlayLayerContext = createContext<number | undefined>(undefined);

/** Above every static overlay in CSS (highest is .weq-ra-layer at 1200), but
 *  below the toast host (4000), which must stay on top of everything. */
export const OVERLAY_BASE_LAYER = 1200;
export const OVERLAY_TOAST_LAYER = 4000;
const layers: symbol[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const notify = () => {
  for (const listener of listeners) listener();
};
function layerFor(key: symbol): number | undefined {
  const index = layers.indexOf(key);
  return index < 0 ? undefined : OVERLAY_BASE_LAYER + index + 1;
}
function release(key: symbol) {
  const index = layers.indexOf(key);
  if (index < 0) return;
  layers.splice(index, 1);
  notify();
}
function activate(key: symbol, front = false) {
  const index = layers.indexOf(key);
  if (index >= 0 && (!front || index === layers.length - 1)) return;
  if (index >= 0) layers.splice(index, 1);
  if (layers.length >= OVERLAY_TOAST_LAYER - OVERLAY_BASE_LAYER - 1)
    throw new Error('同时打开的浮层过多。');
  layers.push(key);
  notify();
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
 * Rank a layer while active. Reopening moves it above current siblings;
 * closing releases its slot. Inactive callers can fall back to their CSS value.
 */
export function useOverlayLayer(active: boolean, revision = 0): number | undefined {
  const parentLayer = useContext(OverlayLayerContext);
  const key = useRef(Symbol('overlay')).current;
  const previousRevision = useRef(revision);
  const layer = useSyncExternalStore(
    subscribe,
    () => layerFor(key),
    () => undefined,
  );
  useLayoutEffect(() => {
    if (active) activate(key);
    else release(key);
    return () => release(key);
  }, [active, key]);
  // 子组件的 layout effect 先执行；父层注册或重新置前后再校准子层。
  useLayoutEffect(() => {
    if (active)
      activate(
        key,
        revision !== previousRevision.current ||
          (parentLayer !== undefined && (layerFor(key) ?? 0) <= parentLayer),
      );
    previousRevision.current = revision;
  }, [active, key, parentLayer, revision]);
  return active ? layer : undefined;
}
