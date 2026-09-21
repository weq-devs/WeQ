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

import type { BubbleSkin, FontDerived, ResolvedWidget } from '@weq/service';
import {
  dressBubbleUrl,
  dressBubbleFrameUrl,
  dressPendantFrameUrl,
  dressFontUrl,
  dressFontFrameUrl,
} from './resourceUrl';
import {
  bubbleLinkMentionRules,
  bubbleRestrictsTextColor,
  fontFxRules,
  toFontFxSkin,
  fxClipMaskCss,
} from './dressSkin';

const STYLE_ID = 'weq-msg-decoration';
const BUBBLE_SCALE = 0.5;
const PAD_RATIO_Y = 0.6;

const injectedBubbles = new Set<number>();
/**
 * 已注入过 CSS 的字体。
 *
 * 键里带**派生版本**：升级后同一款字体的产物被就地重做成新内容，但注入是
 * 「write-once per id」的 —— 不带版本就会拿着旧 ttf / 旧帧 url 赖着不换。
 */
const injectedFonts = new Set<string>();
const injectedWidgets = new Set<number>();

/**
 * 持久强引用：已解码的帧图片必须有人持有，否则浏览器在内存压力下可能丢弃解码缓存，
 * 导致 CSS @keyframes 动画第一圈各帧重新解码，出现高频闪烁。
 */
const liveImages = new Map<string, HTMLImageElement>();

/**
 * 预加载并完全解码一批图片 URL，全部就绪后 resolve（单张失败不阻塞）。
 *
 * 用 `img.decode()` 而非 `img.onload`：
 *   - onload：字节下载完即触发，图片可能还在后台解码线程里，动画启动时逐帧触发解码 → 闪烁
 *   - decode()：保证图片完全解码进内存，可直接合成
 *
 * resolve 后额外等两个绘制帧，让浏览器把解码结果提交到 GPU 纹理缓存，
 * 避免动画第一圈仍因纹理上传延迟而闪烁。
 */
function preloadImages(urls: string[]): Promise<void> {
  return Promise.all(
    urls.map(async (url) => {
      if (liveImages.has(url)) return;
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        // 404 / 格式错误时 decode() 会 reject，当成成功处理，不阻塞整体。
      }
      // 保持强引用，防止 GC 后解码缓存被丢弃。
      liveImages.set(url, img);
    }),
  ).then(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

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

/**
 * 展开成完整选择器列表。CSS 的 `a, b c` 只给最后一项加后缀，所以 `LINE_ATTR` 的两份
 * 前缀必须各自带上 `.message-content` 后缀显式展开，不能合并成一条再拼。
 *
 * `suffix` 用于伪元素（如 `::after`）—— 它同样必须拼到**每一项**末尾，否则只加到
 * 逗号列表最后一项，前一项会命中真实元素本身（历史上导致气泡被误应用
 * `position:absolute; inset:0` 而拉满整个消息列表，见 git blame 2066029 修复）。
 */
function lineContentSel(attr: 'bubble' | 'font', id: number, suffix = ''): string {
  const content =
    '.message-content' +
    ':not(.sticker-only):not(.markdown-image-only):not(.qq-card-only):not(.qq-voice-only)';
  return (
    `.message-line[data-${attr}="${id}"] ${content}${suffix}, ` +
    `.weq-forward-row[data-${attr}="${id}"] ${content}${suffix}`
  );
}

/** Selector: any message line (timeline or forward row) whose bubble id matches. */
function bubbleSel(bubbleId: number): string {
  return lineContentSel('bubble', bubbleId);
}

/**
 * 对方消息（主时间线的 `.theirs` 行 + 合并转发行）的气泡选择器。
 *
 * QQ 的九宫格素材按「自己的右侧气泡」绘制（尖角/装饰朝左），放到左侧的对方消息上
 * 必须左右镜像，尖角才朝右指向会话中心。转发子消息也是「avatar 在左、气泡在右」的
 * 对方样式，一并镜像。
 *
 * `suffix` 用于伪元素（如 `::before` / `::after`）—— 必须拼到**每一项**末尾，
 * 否则只加到逗号列表最后一项（见 {@link lineContentSel} 的同款说明）。
 */
function theirsBubbleSel(bubbleId: number, suffix = ''): string {
  const content =
    '.message-content' +
    ':not(.sticker-only):not(.markdown-image-only):not(.qq-card-only):not(.qq-voice-only)';
  return (
    `.message-line.theirs[data-bubble="${bubbleId}"] ${content}${suffix}, ` +
    `.weq-forward-row[data-bubble="${bubbleId}"] ${content}${suffix}`
  );
}

function fontSel(fontId: number): string {
  return lineContentSel('font', fontId);
}

/**
 * 逐条消息字体的**我方 / 对方行**选择器（行级，不带 `.message-content`）。
 *
 * 炫彩帧（`eimg`）要按行分侧挂到不同的伪元素上：我方行用 `::before`（`::after` 留给
 * 气泡自己的动效叠加层），对方行 / 转发行用 `::after`（`::before` 被镜像底图占着）。
 * 详见 lib/dressSkin 的 fontFxRules。
 */
function fontMineLineSel(fontId: number): string {
  return `.message-line[data-font="${fontId}"]:not(.theirs)`;
}

function fontTheirsLineSel(fontId: number): string {
  return (
    `.message-line[data-font="${fontId}"].theirs, ` +
    `.weq-forward-row[data-font="${fontId}"]`
  );
}

/**
 * 炫彩帧裁形的行级选择器 —— 只要「这一行真的挂了帧」（`[data-fontfx]`）。
 *
 * 与 {@link fontMineLineSel} / {@link fontTheirsLineSel} 同构，只是触发条件换成属性：
 * 帧可能来自逐条消息字体（40801），也可能来自生效字体，两者都会在行上留下
 * `data-fontfx`（见 hooks/useBubbleFontFx）。
 */
function fxClipMineSel(bubbleId: number): string {
  return `.message-line[data-bubble="${bubbleId}"][data-fontfx]:not(.theirs)`;
}

function fxClipTheirsSel(bubbleId: number): string {
  return (
    `.message-line.theirs[data-bubble="${bubbleId}"][data-fontfx], ` +
    `.weq-forward-row[data-bubble="${bubbleId}"][data-fontfx]`
  );
}

/** 行级选择器 + 行内部的 `.message-content` + 伪元素（逗号列表逐项展开）。 */
function fxClipTarget(lineSel: string, pseudo: '::before' | '::after'): string {
  const content =
    '.message-content' +
    ':not(.sticker-only):not(.markdown-image-only):not(.qq-card-only):not(.qq-voice-only)';
  return lineSel
    .split(',')
    .map((s) => `${s.trim()} ${content}${pseudo}`)
    .join(',\n');
}

/**
 * Build the `@keyframes` block + `animation` shorthand for a bubbleframe
 * sequence (each frame its own nine-patch PNG — see BubbleSkin.animationFrameCount).
 *
 * `steps(1)` on the shorthand makes each keyframe's `border-image-source` hold
 * for its whole segment instead of the default discrete-property "flip at the
 * midpoint" behavior — otherwise every frame would only show for half its
 * intended duration, offset from the next.
 *
 * The keyframes drive the **animation overlay layer** (`::after`), never the
 * static bubble base — see {@link layerRule}.
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
 * One nine-patch layer as a pseudo-element rule (mirror of dressSkin.ts's
 * `ninePatchLayer`): the static bubble base on `::before`, the bubbleframe
 * animation on `::after`.
 *
 * `bubbleframe/*.9.png` frames are **overlays**, not whole bubbles: their middle
 * is hollow (2116371's 12 frames have 0/4 opaque pixels in the fill region, and
 * 52 of the 55 installed animated bubbles look the same), they only carry the
 * ornaments above/below the bubble. Painting a frame as the base therefore
 * leaves the bubble body completely transparent, which is why the base layer is
 * always the plain `aio_user_bg_nor.9.png`.
 *
 * `z-index` stays negative: the bubble element opens a stacking context
 * (`isolation: isolate`), so negative layers paint above the element's own
 * background/border but below its text — exactly the slot between base and text.
 */
function layerRule(
  sel: string,
  slice: string,
  width: string,
  opts: { imageUrl: string; zIndex: number; mirror?: boolean; animation?: string },
): string {
  return [
    `${sel} {`,
    `  content: "";`,
    `  position: absolute;`,
    `  inset: 0;`,
    `  z-index: ${opts.zIndex};`,
    `  pointer-events: none;`,
    `  border-style: solid;`,
    `  border-width: 0;`,
    `  border-image-source: url("${opts.imageUrl}");`,
    `  border-image-slice: ${slice};`,
    `  border-image-width: ${width};`,
    `  border-image-repeat: stretch;`,
    `  border-radius: 0;`,
    opts.mirror ? `  transform: scaleX(-1);` : '',
    opts.animation ? `  animation: ${opts.animation};` : '',
    `}`,
  ]
    .filter(Boolean)
    .join('\n');
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
  const theirsSel = theirsBubbleSel(skin.itemId);
  // `sel` 是逗号选择器列表,`::after` 不能直接往上拼 —— 那样只会加到最后一项目上,
  // 前面那项会命中真实元素(见 lineContentSel 的历史坑)。用带 suffix 的版本展开。
  const overlaySel = lineContentSel('bubble', skin.itemId, '::after');

  // 纵向 padding:基础按 0.6 比例,不对称时用差值补偿。
  const avgSlice = (top + bottom) / 2;
  const topDiff = avgSlice - top;
  const bottomDiff = avgSlice - bottom;
  const topPad = wTop * PAD_RATIO_Y + topDiff * BUBBLE_SCALE * 0.6;
  const bottomPad = wBottom * PAD_RATIO_Y + bottomDiff * BUBBLE_SCALE * 0.6;

  // 动效叠加层:帧图中间镂空,只能叠在静态底图之上(见 layerRule 的说明)。
  const frameAnim =
    skin.animationFrameCount && skin.animationFrameTimeMs
      ? frameAnimationCss(
          skin.itemId,
          skin.animationFrameCount,
          skin.animationFrameTimeMs,
          skin.animationRepeat ?? 0,
        )
      : null;

  // local-only:气泡永远是本地九宫格(zip 链下载),没有 CDN 直链分支。
  // 底图恒为 `aio_user_bg_nor.9.png` 那张 —— 与有没有动效无关。
  const imageUrl = dressBubbleUrl(skin.itemId);

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
    `  padding: ${px(topPad)} ${px(Math.max(wLeft, wRight))} ${px(bottomPad)};`,
    `  min-width: ${px((left + right) * BUBBLE_SCALE)};`,
    `  min-height: ${px((top + bottom) * BUBBLE_SCALE)};`,
    `}`,
  ];

  // 炫彩帧的裁形：帧画在伪元素上（我方 `::before`、对方 `::after`），这里把同一张
  // 九宫格当遮罩贴上去，把帧超出气泡形状的部分裁掉 —— 与 lib/dressSkin 的
  // fxClipMaskCss 同构（slice/width 与底图完全一致，遮罩形状因此与气泡一模一样）。
  // 选择器带 `[data-fontfx]`，所以没挂帧的消息一个字节也不多注入。
  rules.push(
    fxClipMaskCss(fxClipTarget(fxClipMineSel(skin.itemId), '::before'), {
      imageUrl,
      slice,
      width,
    }),
  );
  // 对方的帧与气泡动效叠加层共用 `::after`；叠加层是气泡外面的装饰，遮罩会连它
  // 一起裁掉（`data-fontfx` 一直挂在行上，裁掉就是永久的），所以有动效时跳过。
  if (!frameAnim) {
    rules.push(
      fxClipMaskCss(fxClipTarget(fxClipTheirsSel(skin.itemId), '::after'), {
        imageUrl,
        slice,
        width,
      }),
    );
  }

  // 我方/非镜像侧的动效叠加层(先于镜像规则注入,对方的同名选择器靠后覆盖)。
  // 这里先不挂 animation —— 等所有帧图片预加载完再开播,避免第一圈逐帧闪烁。
  if (frameAnim) {
    rules.push(
      layerRule(overlaySel, slice, width, {
        imageUrl: dressBubbleFrameUrl(skin.itemId, 1),
        zIndex: -1,
      }),
    );
  }

  // 对方消息镜像：不能对整个 .message-content 做 scaleX(-1)（文字会跟着镜像），
  // 所以两层贴图都挪到伪元素上翻转，文字留在元素自身不动：底图 ::before
  // (z-index -2)、动效层 ::after(z-index -1)。与 dressSkin.ts bubbleRules()
  // 里 scope=all 的那组镜像规则同构。
  rules.push(
    `${theirsSel} {`,
    `  border-image-source: none;`,
    `}`,
    layerRule(theirsBubbleSel(skin.itemId, '::before'), slice, width, {
      imageUrl,
      zIndex: -2,
      mirror: true,
    }),
  );

  if (frameAnim) {
    rules.push(
      layerRule(theirsBubbleSel(skin.itemId, '::after'), slice, width, {
        imageUrl: dressBubbleFrameUrl(skin.itemId, 1),
        zIndex: -1,
        mirror: true,
      }),
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

  // 文字色受限的气泡：链接 / @提及不再标蓝（会和气泡文字色冲突），改为继承气泡色 + 下划线。
  if (bubbleRestrictsTextColor(skin.textColor)) {
    rules.push(bubbleLinkMentionRules(sel));
  }

  append(rules.join('\n'));

  if (frameAnim) {
    // 先注入静态帧，等全部帧图片预加载完再开启动画，避免帧未缓存时的闪烁。
    const frameUrls = Array.from({ length: skin.animationFrameCount! }, (_, i) =>
      dressBubbleFrameUrl(skin.itemId, i + 1),
    );
    void preloadImages(frameUrls).then(() => {
      append(
        `${overlaySel} { animation: ${frameAnim.animation}; }\n` +
          `${theirsBubbleSel(skin.itemId, '::after')} { animation: ${frameAnim.animation}; }\n` +
          `@media (prefers-reduced-motion: reduce) { ${overlaySel} { animation: none; } ${theirsBubbleSel(skin.itemId, '::after')} { animation: none; } }`,
      );
    });
  }
}

/**
 * 逐条消息字体的 CSS（字体 + 它的炫彩帧）。已注入过的（同款同派生版本）直接返回。
 *
 * 与气泡动效不同，炫彩那份**不推迟开播**：它本来就只有一个变体会生效（渲染侧量完
 * 气泡尺寸才挂 `data-fontfx`，见 useBubbleFontFx），等属性挂上时帧解码早跑完了；
 * 这里只需顺手预热（帧图是本地 protocol 文件，基本秒到）。
 */
export function injectFontCss(fontId: number, font: FontDerived | null): void {
  const deriveVersion = font?.deriveVersion ?? 0;
  const key = `${fontId}:${deriveVersion}`;
  if (injectedFonts.has(key)) return;
  injectedFonts.add(key);

  const url = dressFontUrl(fontId, deriveVersion);
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

  const fxSkin = toFontFxSkin(font);
  const rules = [
    `${fontSel(fontId)} {` +
      `  font-family: "${family}", var(--im-font-body, Inter), ui-sans-serif, system-ui, sans-serif;` +
      `}`,
    // 炫彩：规则一直都在，挂不挂属性由渲染侧量完气泡尺寸决定。
    fxSkin
      ? fontFxRules(fxSkin, {
          mine: fontMineLineSel(fontId),
          theirs: fontTheirsLineSel(fontId),
        })
      : '',
  ];
  append(rules.filter(Boolean).join('\n'));

  if (fxSkin) {
    // 先解码再等属性挂上（属性是量完尺寸才挂的，帧解完码差不多刚好）——
    // 第一圈逐帧解码会肉眼看得出闪，与气泡动效同一个坑。
    const total = fxSkin.fx.variants.reduce((n, v) => n + v.frames.length, 0);
    void preloadImages(
      Array.from({ length: total }, (_, i) => dressFontFrameUrl(fontId, i + 1, deriveVersion)),
    );
  }
}

/** Selector: the pendant overlay element inside a message line whose widget id matches. */
function widgetSel(widgetId: number): string {
  return (
    `.message-line[data-widget="${widgetId}"] .weq-avatar-pendant-img, ` +
    `.weq-forward-row[data-widget="${widgetId}"] .weq-avatar-pendant-img`
  );
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
    `}`,
  ];

  append(rules.join('\n'));

  // 先注入静态帧，等全部帧图片预加载完再开启动画，避免帧未缓存时的闪烁。
  const frameUrls = Array.from({ length: widget.frameCount }, (_, i) =>
    dressPendantFrameUrl(widget.itemId, i + 1),
  );
  void preloadImages(frameUrls).then(() => {
    append(
      `${sel} { animation: ${frameAnim.animation}; }\n` +
        `@media (prefers-reduced-motion: reduce) { ${sel} { animation: none; } }`,
    );
  });
}
