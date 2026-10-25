import { useLayoutEffect, type RefObject } from 'react';
import { surfaceRoot } from './surfaceEscape';

const backgrounds = new WeakMap<HTMLElement, { owners: Set<symbol>; inert: boolean }>();

/** 仅隔离打开时已存在的背景；随后打开的子弹窗仍可交互，嵌套关闭按所有权恢复。 */
export function useModalBackground(ref: RefObject<HTMLElement | null>, active = true) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const root = surfaceRoot(element);
    const layer = Number.parseInt(root.style.zIndex, 10);
    const owner = Symbol();
    const acquired: HTMLElement[] = [];
    for (const sibling of element.ownerDocument.body.children) {
      if (
        !(sibling instanceof HTMLElement) ||
        sibling === root ||
        sibling.contains(root) ||
        sibling.matches('script, style, link') ||
        Number.parseInt(sibling.style.zIndex, 10) > layer
      )
        continue;
      let state = backgrounds.get(sibling);
      if (!state) {
        state = { owners: new Set(), inert: sibling.hasAttribute('inert') };
        backgrounds.set(sibling, state);
      }
      state.owners.add(owner);
      sibling.setAttribute('inert', '');
      acquired.push(sibling);
    }
    return () => {
      for (const sibling of acquired) {
        const state = backgrounds.get(sibling);
        if (!state) continue;
        state.owners.delete(owner);
        if (!state.owners.size) {
          sibling.toggleAttribute('inert', state.inert);
          backgrounds.delete(sibling);
        }
      }
    };
  }, [ref, active]);
}
