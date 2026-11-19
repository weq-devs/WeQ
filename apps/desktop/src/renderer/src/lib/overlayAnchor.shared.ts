import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { useRenderDocument } from './renderDocument';
import { visibleViewport } from './visibleViewport';

export type OverlayAnchor = { element: HTMLElement; rect: DOMRect };
export const OverlayAnchorContext = createContext<RefObject<OverlayAnchor | null> | null>(null);

/** 在捕获阶段记住入口，兼容鼠标点击不自动聚焦按钮的平台与键盘触发。 */
export function useOverlayAnchor(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  enabled: boolean,
  explicit?: HTMLElement | OverlayAnchor | null,
  preferred: 'above' | 'below' | 'side' = 'below',
) {
  const document = useRenderDocument();
  const parent = useContext(OverlayAnchorContext);
  const trigger = useRef<OverlayAnchor | null>(null);
  const source = useRef<OverlayAnchor | null | undefined>(undefined);
  const element = explicit && 'element' in explicit ? explicit.element : explicit;
  if (!active) source.current = undefined;
  else if (source.current === undefined || (element && source.current?.element !== element))
    source.current = explicit
      ? 'element' in explicit
        ? explicit
        : { element: explicit, rect: explicit.getBoundingClientRect() }
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
      const { width, height, left, top } = visibleViewport(view);
      const rect = card.getBoundingClientRect();
      const cardWidth = card.offsetWidth || rect.width;
      const cardHeight = card.offsetHeight || rect.height;
      const beside =
        preferred === 'side'
          ? target.right + cardWidth + 16 <= left + width
            ? target.right + 8
            : target.left - cardWidth - 8 >= left + 8
              ? target.left - cardWidth - 8
              : null
          : null;
      const x = Math.max(left + 8, Math.min(beside ?? target.left, left + width - cardWidth - 8));
      const below = target.bottom + 8;
      const above = target.top - cardHeight - 8;
      const y = Math.max(
        top + 8,
        Math.min(
          beside !== null
            ? target.top
            : preferred === 'above' && above >= top + 8
              ? above
              : below + cardHeight <= top + height - 8
                ? below
                : above,
          top + height - cardHeight - 8,
        ),
      );
      setPosition({
        '--weq-popover-left': `${x}px`,
        '--weq-popover-top': `${y}px`,
      } as CSSProperties);
    };
    place();
    view?.addEventListener('resize', place);
    view?.visualViewport?.addEventListener('resize', place);
    view?.visualViewport?.addEventListener('scroll', place);
    layer.ownerDocument.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place);
    observer.observe(card);
    observer.observe(anchor.element);
    const mutations = new MutationObserver(place);
    for (let element: HTMLElement | null = anchor.element; element; element = element.parentElement)
      mutations.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => {
      view?.removeEventListener('resize', place);
      view?.visualViewport?.removeEventListener('resize', place);
      view?.visualViewport?.removeEventListener('scroll', place);
      layer.ownerDocument.removeEventListener('scroll', place, true);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [active, enabled, anchor, ref, document, preferred]);
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
