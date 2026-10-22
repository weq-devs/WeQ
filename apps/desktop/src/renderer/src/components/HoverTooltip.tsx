import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../styles/hover-tooltip.css';
import { useRenderDocument } from '../lib/renderDocument';
import { useRestrictedMode } from '../state/restrictedMode';
import { restrictedActionTitle } from '../lib/restrictedMode';

// Half Chromium's 500 ms default; native title timing itself is not configurable.
const HOVER_DELAY_MS = 250;
const TOOLTIP_ID = 'weq-hover-tooltip';
type Tooltip = { text: string; x: number; y: number };

/** Delegate existing title hints, including portal dialogs, through one timed host. */
export function HoverTooltip() {
  const document = useRenderDocument();
  const window = document.defaultView ?? globalThis.window;
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = bubble.current;
    if (!element || !tooltip) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(tooltip.x, window.innerWidth - bounds.width - 8))}px`;
    const below = tooltip.y + bounds.height <= window.innerHeight - 8;
    element.style.top = `${Math.max(8, below ? tooltip.y : tooltip.y - bounds.height - 28)}px`;
  }, [tooltip, window]);

  useEffect(() => {
    let owner: Element | null = null;
    let text = '';
    let originalTitle = '';
    let point = { x: 0, y: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let suppliedLabel: string | null = null;
    let observer: MutationObserver;
    const hint = (element: Element) => {
      const title = element.getAttribute('title') ?? '';
      const restriction = useRestrictedMode.getState();
      if (
        element.matches(':disabled, [aria-disabled="true"]') &&
        element.closest('[data-qq-action]') &&
        (restriction.reasons.length || restriction.requests.length)
      ) {
        const label = element.getAttribute('aria-label') || element.textContent?.trim() || '此项';
        const editing = element.matches(
          'input, textarea, select, [role="switch"], [role="checkbox"]',
        );
        return restrictedActionTitle(title || (editing ? `修改${label}` : label));
      }
      const inherited = element.closest('fieldset:disabled')?.getAttribute('data-disabled-reason');
      return inherited && title ? `${title}：${inherited}` : title;
    };

    const removeDescription = (element: Element): void => {
      const ids = (element.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((id) => id && id !== TOOLTIP_ID);
      if (ids.length) element.setAttribute('aria-describedby', ids.join(' '));
      else element.removeAttribute('aria-describedby');
    };
    const clear = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      observer.disconnect();
      if (owner) {
        // Only restore a title still suppressed by this host, not a later React update.
        if (owner.getAttribute('title') === '') owner.setAttribute('title', originalTitle);
        removeDescription(owner);
        if (suppliedLabel !== null && owner.getAttribute('aria-label') === suppliedLabel)
          owner.removeAttribute('aria-label');
      }
      owner = null;
      suppliedLabel = null;
      visible = false;
      setTooltip(null);
    };
    const supplyAccessibleName = (): void => {
      if (!owner) return;
      if (suppliedLabel !== null && owner.getAttribute('aria-label') === suppliedLabel) {
        owner.setAttribute('aria-label', text);
        suppliedLabel = text;
      } else if (
        !owner.hasAttribute('aria-label') &&
        !owner.hasAttribute('aria-labelledby') &&
        !owner.textContent?.trim() &&
        owner.matches('button, a, [role="button"]')
      ) {
        owner.setAttribute('aria-label', text);
        suppliedLabel = text;
      }
    };
    const observe = (): void => {
      if (!owner) return;
      observer.observe(owner, { attributes: true, attributeFilter: ['title'] });
      // No tree scans: a removed hovered element only needs a connection check.
      observer.observe(document.body, { childList: true, subtree: true });
    };
    observer = new window.MutationObserver((records) => {
      if (!owner) return;
      if (!owner.isConnected) {
        clear();
        return;
      }
      if (!records.some((record) => record.type === 'attributes' && record.target === owner))
        return;
      const next = owner.getAttribute('title');
      if (!next?.trim()) {
        text = next ?? '';
        clear();
        return;
      }
      originalTitle = next;
      text = hint(owner);
      observer.disconnect();
      owner.setAttribute('title', '');
      supplyAccessibleName();
      observe();
      if (visible) setTooltip({ text, ...point });
    });
    const findOwner = (target: EventTarget | null): Element | null => {
      const element =
        target instanceof window.Element
          ? target
          : target instanceof window.Node
            ? target.parentElement
            : null;
      return (
        element?.closest(
          '[title], [data-qq-action] :disabled[aria-label], [data-qq-action] button:disabled',
        ) ?? null
      );
    };
    const enter = (next: Element | null, x: number, y: number): void => {
      if (next && next === owner) return;
      clear();
      const title = next ? hint(next) : null;
      if (!next || !title?.trim()) return;
      owner = next;
      originalTitle = next.getAttribute('title') ?? '';
      text = title;
      point = { x, y };
      supplyAccessibleName();
      owner.setAttribute('title', '');
      observe();
      timer = setTimeout(() => {
        timer = undefined;
        if (!owner?.isConnected) {
          clear();
          return;
        }
        const ids = new Set(
          (owner.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean),
        );
        ids.add(TOOLTIP_ID);
        owner.setAttribute('aria-describedby', [...ids].join(' '));
        visible = true;
        setTooltip({ text, ...point });
      }, HOVER_DELAY_MS);
    };
    const over = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || event.buttons) return;
      enter(findOwner(event.target), event.clientX + 12, event.clientY + 18);
    };
    const out = (event: PointerEvent): void => {
      if (owner && findOwner(event.relatedTarget) !== owner) clear();
    };
    const focus = (event: FocusEvent): void => {
      const next = findOwner(event.target);
      if (!next) return;
      const bounds = next.getBoundingClientRect();
      enter(next, bounds.left, bounds.bottom + 8);
    };
    const focusOut = (): void => clear();
    const leave = (event: PointerEvent): void => {
      if (!event.relatedTarget) clear();
    };
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('pointerleave', leave);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', focusOut, true);
    document.addEventListener('pointerdown', clear, true);
    document.addEventListener('keydown', clear, true);
    document.addEventListener('scroll', clear, true);
    window.addEventListener('blur', clear);
    window.addEventListener('resize', clear);
    return () => {
      clear();
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('pointerleave', leave);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('focusout', focusOut, true);
      document.removeEventListener('pointerdown', clear, true);
      document.removeEventListener('keydown', clear, true);
      document.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur', clear);
      window.removeEventListener('resize', clear);
    };
  }, [document, window]);

  return tooltip
    ? createPortal(
        <div
          ref={bubble}
          id={TOOLTIP_ID}
          className="weq-hover-tooltip"
          role="tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>,
        document.body,
      )
    : null;
}
