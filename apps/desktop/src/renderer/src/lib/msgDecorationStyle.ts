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

import type { BubbleSkin } from '@weq/service';
import { dressBubbleUrl, dressFontUrl, dressUrl } from './resourceUrl';

const STYLE_ID = 'weq-msg-decoration';
const BUBBLE_SCALE = 0.5;
const PAD_RATIO_Y = 0.6;

const injectedBubbles = new Set<number>();
const injectedFonts = new Set<number>();

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
  const imageUrl = skin.localFile ? dressBubbleUrl(skin.itemId) : dressUrl(skin.staticUrl);
  const sel = bubbleSel(skin.itemId);

  const rules = [
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
    `  padding: ${px(Math.min(wTop, wBottom) * PAD_RATIO_Y)} ${px(Math.max(wLeft, wRight))};`,
    `  min-width: ${px((left + right) * BUBBLE_SCALE)};`,
    `  min-height: ${px((top + bottom) * BUBBLE_SCALE)};`,
    `}`,
  ];

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
  void new FontFace(family, `url("${url}")`).load().then((face) => {
    document.fonts.add(face);
  });

  append(
    `${fontSel(fontId)} {` +
      `  font-family: "${family}", var(--im-font-body, Inter), ui-sans-serif, system-ui, sans-serif;` +
      `}`,
  );
}
