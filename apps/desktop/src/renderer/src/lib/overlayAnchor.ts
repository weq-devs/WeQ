import { createElement, useEffect, useRef, type ReactNode } from 'react';
import { useRenderDocument } from './renderDocument';
import { type OverlayAnchor, OverlayAnchorContext } from './overlayAnchor.shared';

/** 全局宿主与页面级入口也保留触发点，不依赖浏览器是否自动聚焦按钮。 */
export function OverlayAnchorProvider({ children }: { children: ReactNode }) {
  const document = useRenderDocument();
  const trigger = useRef<OverlayAnchor | null>(null);
  useEffect(() => {
    const capture = (event: Event) => {
      const ElementType = document.defaultView?.Element;
      if (!ElementType || !(event.target instanceof ElementType)) return;
      const element = event.target.closest<HTMLElement>('button, a, input, [role="button"]');
      if (element) trigger.current = { element, rect: element.getBoundingClientRect() };
    };
    document.addEventListener('pointerdown', capture, true);
    document.addEventListener('click', capture, true);
    return () => {
      document.removeEventListener('pointerdown', capture, true);
      document.removeEventListener('click', capture, true);
    };
  }, [document]);
  return createElement(OverlayAnchorContext.Provider, { value: trigger }, children);
}
