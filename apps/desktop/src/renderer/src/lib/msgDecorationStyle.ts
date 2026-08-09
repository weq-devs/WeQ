/**
 * Per-message decoration CSS injection.
 *
 * Each unique bubbleId / fontId encountered in the chat gets its own CSS rule
 * injected into a single <style> element. Messages carry `data-bubble="{id}"`
 * and `data-font="{id}"` attributes; the CSS selects on those.
 *
 * CSS is write-once per itemId (same id → cache hit, never re-injected),
 * matching the server-side MsgDecorationCacheService guarantee.
 */

import type { BubbleSkin, ResolvedWidget } from '@weq/service';
import { dressBubbleUrl, dressBubbleFrameUrl, dressPendantFrameUrl, dressFontUrl, dressUrl } from './resourceUrl';

const STYLE_ID = 'weq-msg-decoration';
const BUBBLE_SCALE = 0.5;
const PAD_RATIO_Y = 0.6;

const injectedBubbles = new Set<number>();
const injectedFonts = new Set<number>();
const injectedWidgets = new Set<number>();

function px(v: number): string {
  return `${Math.round(v * 100) / 100}px`;
}

function getOrCreate(): HTMLStyleElement {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  return el;
}

function append(css: string): void {
  const el = getOrCreate();
  el.textContent = `${el.textContent ?? ''}\n${css}`;
}

/** Selector: any message line whose bubble id matches. */
function bubbleSel(bubbleId: number): string {
  const base = `.message-line[data-bubble="${bubbleId}"]`;
  return (
    `${base} .message-content` +
    ':not(.sticker-only):not(.markdown-image-only):not(.qq-card-only):not(.qq-voice-only)'
  );
}

function fontSel(fontId: number): string {
  return (
    `.message-line[data-font="${fontId}"] .message-content` +
    ':not(.sticker-only):not(.markdown-image-only):not(.qq-card-only):not(.qq-voice-only)'
  );
}

/**
 * Build the `@keyframes` block + `animation` shorthand for a bubbleframe
 * sequence (each frame its own nine-patch PNG — see BubbleSkin.animationFrameCount).
 *
 * `steps(1)` on the shorthand makes each keyframe's `border-image-source` hold
 * for its whole segment instead of the default discrete-property "flip at the
 * midpoint" behavior — otherwise every frame would only show for half its
 * intended duration, offset from the next.
 */
function frameAnimationCss(
  itemId: number,
  frameCount: number,
  frameTimeMs: number,
  repeat: number,
): { keyframes: string; animation: string } {
  const name = `weq-bubbleframe-${itemId}`;
  const step = 100 / frameCount;
  const stops = Array.from({ length: frameCount }, (_, i) => {
    const pct = Math.round(Math.min(i * step, 100) * 100) / 100;
    return `  ${pct}% { border-image-source: url("${dressBubbleFrameUrl(itemId, i + 1)}"); }`;
  });
  const keyframes = [`@keyframes ${name} {`, ...stops, `}`].join('\n');
  const duration = frameCount * frameTimeMs;
  const iterations = repeat > 0 ? repeat : 'infinite';
  return { keyframes, animation: `${name} ${duration}ms steps(1) ${iterations}` };
}

/**
 * Inject CSS rules for one bubble skin.  No-op if already injected.
 * Mirror of dressSkin.ts bubbleRules(), but scoped to data-bubble attribute.
 */
export function injectBubbleCss(skin: BubbleSkin): void {
  if (injectedBubbles.has(skin.itemId)) return;
  injectedBubbles.add(skin.itemId);

  const { left, top, right, bottom } = skin.slice;
  const wTop = top * BUBBLE_SCALE;
  const wRight = right * BUBBLE_SCALE;
  const wBottom = bottom * BUBBLE_SCALE;
  const wLeft = left * BUBBLE_SCALE;
  const slice = `${top} ${right} ${bottom} ${left} fill`;
  const width = `${px(wTop)} ${px(wRight)} ${px(wBottom)} ${px(wLeft)}`;
  const sel = bubbleSel(skin.itemId);

  // Frame animation (protocol fallback path) takes over the base layer's
  // border-image-source entirely — frame 1 doubles as the static/initial
  // paint, so the plain static PNG is never referenced once frames exist.
  const frameAnim =
    skin.animationFrameCount && skin.animationFrameTimeMs
      ? frameAnimationCss(
          skin.itemId,
          skin.animationFrameCount,
          skin.animationFrameTimeMs,
          skin.animationRepeat ?? 0,
        )
      : null;
  const imageUrl = frameAnim
    ? dressBubbleFrameUrl(skin.itemId, 1)
    : skin.localFile
      ? dressBubbleUrl(skin.itemId)
      : dressUrl(skin.staticUrl);

  const rules = [
    frameAnim?.keyframes ?? '',
    `${sel} {`,
    `  position: relative;`,
    `  isolation: isolate;`,
    `  background: transparent;`,
    `  color: ${skin.textColor};`,
    `  border-style: solid;`,
    `  border-width: 0;`,
    `  border-image-source: url("${imageUrl}");`,
    `  border-image-slice: ${slice};`,
    `  border-image-width: ${width};`,
    `  border-image-repeat: stretch;`,
    `  border-radius: 0;`,
    frameAnim ? `  animation: ${frameAnim.animation};` : '',
    `  padding: ${px(Math.min(wTop, wBottom) * PAD_RATIO_Y)} ${px(Math.max(wLeft, wRight))};`,
    `  min-width: ${px((left + right) * BUBBLE_SCALE)};`,
    `  min-height: ${px((top + bottom) * BUBBLE_SCALE)};`,
    `}`,
  ];

  // Respect reduced-motion: freeze on frame 1 instead of cycling.
  if (frameAnim) {
    rules.push(`@media (prefers-reduced-motion: reduce) {`, `  ${sel} { animation: none; }`, `}`);
  }

  if (skin.animationUrl) {
    const animUrl = dressUrl(skin.animationUrl);
    rules.push(
      `${sel}::after {`,
      `  content: "";`,
      `  position: absolute;`,
      `  inset: 0;`,
      `  z-index: -1;`,
      `  pointer-events: none;`,
      `  border-style: solid;`,
      `  border-width: 0;`,
      `  border-image-source: url("${animUrl}");`,
      `  border-image-slice: ${slice};`,
      `  border-image-width: ${width};`,
      `  border-image-repeat: stretch;`,
      `}`,
    );
  }

  // context-active highlight (can't rely on background when border-image is set)
  rules.push(
    `.message-line[data-bubble="${skin.itemId}"] .message-bubble.context-active .message-content {`,
    `  background: transparent;`,
    `  outline: 2px solid var(--weq-accent-effective, #12a8ff);`,
    `  outline-offset: -1px;`,
    `}`,
  );

  append(rules.join('\n'));
}

/** Inject a font-family rule for a fontId. No-op if already injected. */
export function injectFontCss(fontId: number): void {
  if (injectedFonts.has(fontId)) return;
  injectedFonts.add(fontId);

  const url = dressFontUrl(fontId);
  const family = `weq-dress-${fontId}`;

  // Preload the font via FontFace API so the browser doesn't swap mid-render.
  // Some QQ dress fonts fail Chromium's OTS sanitizer ("Failed to decode
  // downloaded font") — that's a real file-format rejection we can't work
  // around client-side. Swallow it: document.fonts never gets the face, so
  // the CSS fallback chain below just takes over, same as dressSkin.ts's
  // preloadFont for the "own equipped font" path.
  void new FontFace(family, `url("${url}")`)
    .load()
    .then((face) => {
      document.fonts.add(face);
    })
    .catch(() => {});

  append(
    `${fontSel(fontId)} {` +
      `  font-family: "${family}", var(--im-font-body, Inter), ui-sans-serif, system-ui, sans-serif;` +
      `}`,
  );
}

/** Selector: the pendant overlay element inside a message line whose widget id matches. */
function widgetSel(widgetId: number): string {
  return `.message-line[data-widget="${widgetId}"] .weq-avatar-pendant-img`;
}

/**
 * Same `@keyframes` trick as {@link frameAnimationCss}, but swaps `background-image`
 * instead of `border-image-source` — the pendant overlay is a plain `<span>` (no
 * nine-patch geometry to preserve), so a background layer is the simpler fit.
 */
function widgetFrameAnimationCss(
  itemId: number,
  frameCount: number,
  frameTimeMs: number,
  repeat: number,
): { keyframes: string; animation: string } {
  const name = `weq-widgetframe-${itemId}`;
  const step = 100 / frameCount;
  const stops = Array.from({ length: frameCount }, (_, i) => {
    const pct = Math.round(Math.min(i * step, 100) * 100) / 100;
    return `  ${pct}% { background-image: url("${dressPendantFrameUrl(itemId, i + 1)}"); }`;
  });
  const keyframes = [`@keyframes ${name} {`, ...stops, `}`].join('\n');
  const duration = frameCount * frameTimeMs;
  const iterations = repeat > 0 ? repeat : 'infinite';
  return { keyframes, animation: `${name} ${duration}ms steps(1) ${iterations}` };
}

/**
 * Inject the `@keyframes` + selector rule for one resolved pendant animation.
 * No-op for the `animated: false` (guessed static URL) shape — that one renders
 * as a plain `<img src>` in messageBubble.tsx, no CSS needed.
 */
export function injectWidgetCss(widget: ResolvedWidget): void {
  if (!widget.animated) return;
  if (injectedWidgets.has(widget.itemId)) return;
  injectedWidgets.add(widget.itemId);

  const frameAnim = widgetFrameAnimationCss(
    widget.itemId,
    widget.frameCount,
    widget.frameTimeMs,
    widget.repeat,
  );
  const sel = widgetSel(widget.itemId);

  const rules = [
    frameAnim.keyframes,
    `${sel} {`,
    `  background-image: url("${dressPendantFrameUrl(widget.itemId, 1)}");`,
    `  background-size: contain;`,
    `  background-position: center;`,
    `  background-repeat: no-repeat;`,
    `  animation: ${frameAnim.animation};`,
    `}`,
    `@media (prefers-reduced-motion: reduce) {`,
    `  ${sel} { animation: none; }`,
    `}`,
  ];

  append(rules.join('\n'));
}
