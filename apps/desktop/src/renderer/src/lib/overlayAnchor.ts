import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type SyntheticEvent,
  type ReactNode,
} from 'react';
import { useRenderDocument } from './renderDocument';

type OverlayAnchor = { element: HTMLElement; rect: DOMRect };
export const OverlayAnchorContext = createContext<RefObject<OverlayAnchor | null> | null>(null);

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

/** 在捕获阶段记住入口，兼容鼠标点击不自动聚焦按钮的平台与键盘触发。 */
export function useOverlayAnchor(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  enabled: boolean,
  explicit?: HTMLElement | null,
) {
  const document = useRenderDocument();
  const parent = useContext(OverlayAnchorContext);
  const trigger = useRef<OverlayAnchor | null>(null);
  const source = useRef<OverlayAnchor | null | undefined>(undefined);
  if (!active) source.current = undefined;
  else if (source.current === undefined || (explicit && source.current?.element !== explicit))
    source.current = explicit
      ? { element: explicit, rect: explicit.getBoundingClientRect() }
      : (parent?.current ?? null);
  if (source.current && source.current.element.ownerDocument !== document) source.current = null;
  const anchor = source.current;
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const layer = ref.current;
    const card = layer?.firstElementChild;
    const HTMLElementType = document.defaultView?.HTMLElement;
    if (
      !active ||
      !enabled ||
      !anchor ||
      !layer ||
      !HTMLElementType ||
      !(card instanceof HTMLElementType)
    ) {
      setPosition(undefined);
      return;
    }
    const view = layer.ownerDocument.defaultView;
    const place = () => {
      const target = anchor.element.getClientRects().length
        ? anchor.element.getBoundingClientRect()
        : anchor.rect;
      const width = view?.innerWidth ?? 1024;
      const height = view?.innerHeight ?? 768;
      const rect = card.getBoundingClientRect();
      const cardWidth = card.offsetWidth || rect.width;
      const cardHeight = card.offsetHeight || rect.height;
      const x = Math.max(8, Math.min(target.left, width - cardWidth - 8));
      const below = target.bottom + 8;
      const y = Math.max(
        8,
        Math.min(
          below + cardHeight <= height - 8 ? below : target.top - cardHeight - 8,
          height - cardHeight - 8,
        ),
      );
      setPosition({
        '--weq-popover-left': `${x}px`,
        '--weq-popover-top': `${y}px`,
      } as CSSProperties);
    };
    place();
    view?.addEventListener('resize', place);
    layer.ownerDocument.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place);
    observer.observe(card);
    observer.observe(anchor.element);
    const mutations = new MutationObserver(place);
    for (let element: HTMLElement | null = anchor.element; element; element = element.parentElement)
      mutations.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => {
      view?.removeEventListener('resize', place);
      layer.ownerDocument.removeEventListener('scroll', place, true);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [active, enabled, anchor, ref, document]);
  const capture = (event: SyntheticEvent<HTMLElement>) => {
    const ElementType = document.defaultView?.Element;
    if (
      !ElementType ||
      !(event.target instanceof ElementType) ||
      !event.currentTarget.contains(event.target)
    )
      return;
    const control = event.target.closest<HTMLElement>('button, a, input, [role="button"]');
    if (control) trigger.current = { element: control, rect: control.getBoundingClientRect() };
  };
  return { trigger, capture, position, anchor };
}
