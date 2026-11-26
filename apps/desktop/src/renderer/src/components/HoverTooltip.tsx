import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../styles/hover-tooltip.css';
import { useRenderDocument } from '../lib/renderDocument';
import { useRestrictedMode } from '../state/restrictedMode';
import { restrictedActionTitle } from '../lib/restrictedMode';
import { shouldDismissHoverHint } from '../lib/hoverHint';
import { usePrivacyStore } from '../state/privacy';
import { useExitMotion } from '../hooks/useExitMotion';

// Half Chromium's 500 ms default; native title timing itself is not configurable.
const HOVER_DELAY_MS = 250;
const TOOLTIP_ID = 'weq-hover-tooltip';
const NATIVE_HINT = '[title]:not([title=""], iframe)';
const HINT_OWNER =
  '[title]:not(iframe), [data-qq-action] :disabled[aria-label], [data-qq-action] button:disabled';
type Tooltip = { text: string; x: number; y: number };

/** Delegate existing title hints, including portal dialogs, through one timed host. */
export function HoverTooltip() {
  const document = useRenderDocument();
  const window = document.defaultView ?? globalThis.window;
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const present = useExitMotion(bubble, Boolean(tooltip));
  const lastTooltip = useRef<Tooltip | null>(null);
  useLayoutEffect(() => {
    const element = bubble.current;
    if (!element || !tooltip) return;
    lastTooltip.current = tooltip;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(tooltip.x, window.innerWidth - bounds.width - 8))}px`;
    const below = tooltip.y + bounds.height <= window.innerHeight - 8;
    element.style.top = `${Math.max(8, below ? tooltip.y : tooltip.y - bounds.height - 28)}px`;
  }, [tooltip, window]);

  useLayoutEffect(() => {
    const body = document.body;
    type ManagedTitle = { text: string; label?: string };
    const titles = new WeakMap<Element, ManagedTitle>();
    let owner: Element | null = null;
    let text = '';
    let point = { x: 0, y: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let keyboardNavigation = false;
    let touchTimer: ReturnType<typeof setTimeout> | undefined;
    let touchStart: { x: number; y: number } | null = null;
    let consumedTouch = false;
    const hint = (element: Element) => {
      const title = element.getAttribute('title') || titles.get(element)?.text || '';
      if (usePrivacyStore.getState().effective) {
        const sensitive = (node: Element) =>
          window.getComputedStyle(node).getPropertyValue('--weq-privacy-sensitive').trim() === '1';
        if (
          element.hasAttribute('data-privacy-title') ||
          sensitive(element) ||
          Array.from(element.querySelectorAll('*')).some(sensitive)
        )
          return '内容已隐藏';
      }
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
      clearTimeout(touchTimer);
      touchStart = null;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (owner) removeDescription(owner);
      owner = null;
      visible = false;
      setTooltip(null);
    };
    const releaseTitle = (element: Element): void => {
      const label = titles.get(element)?.label;
      if (label !== undefined && element.getAttribute('aria-label') === label)
        element.removeAttribute('aria-label');
      titles.delete(element);
    };
    const captureTitle = (element: Element): void => {
      const value = element.getAttribute('title');
      releaseTitle(element);
      if (!value?.trim()) return;
      const entry: ManagedTitle = { text: value };
      if (
        element.matches('button, a, [role="button"]') &&
        !element.hasAttribute('aria-label') &&
        !element.hasAttribute('aria-labelledby') &&
        !element.textContent?.trim() &&
        !element.querySelector('img[alt]:not([alt=""]), [aria-label], svg > title')
      ) {
        entry.label = usePrivacyStore.getState().effective ? hint(element) : value;
        element.setAttribute('aria-label', entry.label);
      }
      titles.set(element, entry);
      // 空值既阻断原生提示继承，也让 React 清空 title 时产生可观察的变更。
      element.setAttribute('title', '');
    };
    const observe = (): void => {
      observer.observe(body, {
        attributes: true,
        attributeFilter: ['title'],
        childList: true,
        subtree: true,
      });
    };
    const observer = new window.MutationObserver((records) => {
      const changed = new Set<Element>();
      for (const record of records) {
        if (record.type === 'attributes') {
          const element = record.target as Element;
          if (element.matches(NATIVE_HINT) || titles.has(element)) changed.add(element);
          continue;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof window.Element) || !node.isConnected) continue;
          if (node.matches(NATIVE_HINT)) changed.add(node);
          if (node.firstElementChild)
            for (const element of node.querySelectorAll(NATIVE_HINT)) changed.add(element);
        }
      }
      if (changed.size) {
        observer.disconnect();
        for (const element of changed) captureTitle(element);
        observe();
      }
      if (owner && !owner.isConnected) clear();
      else if (owner && changed.has(owner)) {
        text = hint(owner);
        if (!text.trim()) clear();
        else if (visible) setTooltip({ text, ...point });
      }
    });
    // 在指针进入之前接管提示，避免浏览器先排入原生提示；不在 hover 结束时恢复。
    for (const element of body.querySelectorAll(NATIVE_HINT)) captureTitle(element);
    observe();
    const findOwner = (target: EventTarget | null): Element | null => {
      const element =
        target instanceof window.Element
          ? target
          : target instanceof window.Node
            ? target.parentElement
            : null;
      return element?.closest(HINT_OWNER) ?? null;
    };
    const enter = (next: Element | null, x: number, y: number): void => {
      if (next && next === owner) return;
      clear();
      const title = next ? hint(next) : null;
      if (!next || !title?.trim()) return;
      owner = next;
      text = title;
      point = { x, y };
      const show = () => {
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
      };
      if (next.closest('[data-hover-delay="0"]')) show();
      else timer = setTimeout(show, HOVER_DELAY_MS);
    };
    const over = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || event.buttons) return;
      enter(findOwner(event.target), event.clientX + 12, event.clientY + 18);
    };
    const out = (event: PointerEvent): void => {
      if (owner && findOwner(event.relatedTarget) !== owner) clear();
    };
    const focus = (event: FocusEvent): void => {
      // 浮层关闭会归还焦点，只有键盘导航才应因此弹出提示。
      if (!keyboardNavigation) return;
      const next = findOwner(event.target);
      if (!next) return;
      const bounds = next.getBoundingClientRect();
      enter(next, bounds.left, bounds.bottom + 8);
    };
    const focusOut = (): void => clear();
    const leave = (event: PointerEvent): void => {
      if (!event.relatedTarget) clear();
    };
    const keydown = (event: KeyboardEvent): void => {
      if (
        ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
          event.key,
        )
      )
        keyboardNavigation = true;
      if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof window.Element) {
        const next = event.target.closest('[data-time-detail]');
        if (next) {
          event.preventDefault();
          event.stopPropagation();
          if (owner === next && visible) clear();
          else {
            const bounds = next.getBoundingClientRect();
            enter(next, bounds.left, bounds.bottom + 8);
          }
          return;
        }
      }
      if (shouldDismissHoverHint(event)) clear();
    };
    const pointerDown = (event: PointerEvent): void => {
      keyboardNavigation = false;
      clearTimeout(touchTimer);
      consumedTouch = false;
      clear();
      const element = event.target instanceof window.Element ? event.target : null;
      if (event.pointerType !== 'touch' || !element?.closest('[data-hover-delay="0"] button'))
        return;
      touchStart = { x: event.clientX, y: event.clientY };
      touchTimer = setTimeout(() => {
        consumedTouch = true;
        enter(findOwner(element), event.clientX + 12, event.clientY + 18);
      }, 460);
    };
    const touchEnd = (): void => {
      clearTimeout(touchTimer);
      touchStart = null;
    };
    const touchMove = (event: PointerEvent): void => {
      if (touchStart && Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 10)
        touchEnd();
    };
    const touchClick = (event: MouseEvent): void => {
      const next =
        event.target instanceof window.Element ? event.target.closest('[data-time-detail]') : null;
      if (next) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (owner === next && visible) clear();
        else {
          const bounds = next.getBoundingClientRect();
          enter(next, bounds.left, bounds.bottom + 8);
        }
        return;
      }
      if (!consumedTouch) return;
      consumedTouch = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const menuContext = (event: MouseEvent): void => {
      if (
        event.target instanceof window.Element &&
        event.target.closest('[data-hover-delay="0"]')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const unsubscribePrivacy = usePrivacyStore.subscribe((state, previous) => {
      if (state.effective === previous.effective) return;
      lastTooltip.current = null;
      if (!owner) {
        for (const animation of bubble.current?.getAnimations?.() ?? []) animation.cancel();
      }
      for (const element of body.querySelectorAll('[title=""][aria-label]')) {
        const entry = titles.get(element);
        if (entry?.label === undefined || element.getAttribute('aria-label') !== entry.label)
          continue;
        entry.label = state.effective ? hint(element) : entry.text;
        element.setAttribute('aria-label', entry.label);
      }
      if (!owner) return;
      text = hint(owner);
      if (visible) setTooltip({ text, ...point });
    });
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('pointerleave', leave);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', focusOut, true);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('pointerup', touchEnd, true);
    document.addEventListener('pointercancel', touchEnd, true);
    document.addEventListener('pointermove', touchMove, true);
    document.addEventListener('click', touchClick, true);
    document.addEventListener('contextmenu', menuContext, true);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('scroll', clear, true);
    window.addEventListener('blur', clear);
    window.addEventListener('resize', clear);
    return () => {
      unsubscribePrivacy();
      observer.disconnect();
      clear();
      touchEnd();
      for (const element of body.querySelectorAll('[title=""]')) {
        const entry = titles.get(element);
        if (!entry) continue;
        element.setAttribute('title', entry.text);
        releaseTitle(element);
      }
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('pointerleave', leave);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('focusout', focusOut, true);
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('pointerup', touchEnd, true);
      document.removeEventListener('pointercancel', touchEnd, true);
      document.removeEventListener('pointermove', touchMove, true);
      document.removeEventListener('click', touchClick, true);
      document.removeEventListener('contextmenu', menuContext, true);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur', clear);
      window.removeEventListener('resize', clear);
    };
  }, [document, window]);

  const shown = tooltip ?? lastTooltip.current;
  return present && shown
    ? createPortal(
        <div
          ref={bubble}
          id={TOOLTIP_ID}
          className="weq-hover-tooltip"
          role="tooltip"
          data-weq-surface-motion="fade"
          data-closing={!tooltip || undefined}
          aria-hidden={!tooltip || undefined}
          style={{ left: shown.x, top: shown.y }}
        >
          {shown.text}
        </div>,
        document.body,
      )
    : null;
}
