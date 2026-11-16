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
export const OverlayLayerContext = createContext<symbol | undefined>(undefined);

/** Above every static overlay in CSS (highest is .weq-ra-layer at 1200), but
 *  below the toast host (4000), which must stay on top of everything. */
export const OVERLAY_BASE_LAYER = 1200;
export const OVERLAY_TOAST_LAYER = 4000;
const layers: symbol[] = [];
const parents = new Map<symbol, symbol>();
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
  parents.delete(key);
  notify();
}
function descendsFrom(key: symbol, ancestor: symbol): boolean {
  for (let parent = parents.get(key); parent; parent = parents.get(parent))
    if (parent === ancestor) return true;
  return false;
}
export function hasOverlayDescendant(scope: symbol): boolean {
  return layers.some((key) => descendsFrom(key, scope));
}
function activate(key: symbol, parent: symbol | undefined, front = false) {
  if (parent) parents.set(key, parent);
  else parents.delete(key);
  const index = layers.indexOf(key);
  if (index >= 0 && !front) return;
  if (index < 0 && layers.length >= OVERLAY_TOAST_LAYER - OVERLAY_BASE_LAYER - 1)
    throw new Error('同时打开的浮层过多。');
  // 父窗置前时整组移动，不能等子组件重渲染后才恢复父子顺序。
  const children = layers.filter((item) => descendsFrom(item, key));
  const branch = new Set([key, ...children]);
  const next = [...layers.filter((item) => !branch.has(item)), key, ...children];
  if (next.length === layers.length && next.every((item, offset) => item === layers[offset]))
    return;
  layers.splice(0, layers.length, ...next);
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
  return useOverlayLayerScope(active, revision).layer;
}

/** 外壳把稳定身份传给 Portal 子树，不以会随排序变化的层号标识父窗。 */
export function useOverlayLayerScope(active: boolean, revision = 0) {
  const parent = useContext(OverlayLayerContext);
  const key = useRef(Symbol('overlay')).current;
  const previousRevision = useRef(revision);
  const layer = useSyncExternalStore(
    subscribe,
    () => layerFor(key),
    () => undefined,
  );
  useLayoutEffect(() => {
    if (active) activate(key, parent);
    else release(key);
    return () => release(key);
  }, [active, key, parent]);
  useLayoutEffect(() => {
    if (active && revision !== previousRevision.current) activate(key, parent, true);
    previousRevision.current = revision;
  }, [active, key, parent, revision]);
  return { layer: active ? layer : undefined, scope: key };
}
