/**
 * 消息装扮按款共享样式和资源。调用方必须归还返回的持有凭据，
 * 最后一个可见使用者离开时移除规则、释放字体和动画帧。
 */

import type { MessageBubbleSkin, FontDerived, ResolvedWidget } from '@weq/service';
import { acquireDecorationStyle, validDecorationFrames } from './decorationResources';
import { fontFaces } from './fontFaces';
import {
  dressBubbleFrameUrl,
  dressPendantFrameUrl,
  dressFontUrl,
  dressFontFrameUrl,
} from './resourceUrl';
import {
  BUBBLE_CONTENT,
  BUBBLE_FRAME_Z_INDEX,
  FONT_FX_LAYER_CLASS,
  bubbleContentAlignmentCss,
  bubbleContentPaddingCss,
  bubbleFrameAnimationCss,
  bubbleGroupSpacingCss,
  bubbleLinkMentionRules,
  bubbleMenuHighlightCss,
  bubbleRestrictsTextColor,
  fontFxRules,
  toFontFxSkin,
  fxClipMaskCss,
  bubbleMetrics,
  fractionalBubbleBase,
  ninePatchLayer,
  fontTextRules,
} from './dressSkin';

/**
 * 展开成完整选择器列表。CSS 的 `a, b c` 只给最后一项加后缀，所以 `LINE_ATTR` 的两份
 * 前缀必须各自带上 `.message-content` 后缀显式展开，不能合并成一条再拼。
 *
 * `suffix` 用于伪元素（如 `::after`）—— 它同样必须拼到**每一项**末尾，否则只加到
 * 逗号列表最后一项，前一项会命中真实元素本身（历史上导致气泡被误应用
 * `position:absolute; inset:0` 而拉满整个消息列表，见 git blame 2066029 修复）。
 */
function lineContentSel(attr: 'bubble' | 'font', id: number, suffix = ''): string {
  return (
    `.message-line[data-${attr}="${id}"] ${BUBBLE_CONTENT}${suffix}, ` +
    `.weq-forward-row[data-${attr}="${id}"] ${BUBBLE_CONTENT}${suffix}`
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
  return (
    `.message-line.theirs[data-bubble="${bubbleId}"] ${BUBBLE_CONTENT}${suffix}, ` +
    `.weq-forward-row[data-bubble="${bubbleId}"] ${BUBBLE_CONTENT}${suffix}`
  );
}

function fontSel(fontId: number): string {
  return lineContentSel('font', fontId);
}

/**
 * 逐条消息字体的**我方 / 对方行**选择器（行级，不带 `.message-content`）。
 *
 * 对方行的字体绘制层需要镜像匹配气泡的裁形；两种方向使用同一个独立绘制层。
 */
function fontMineLineSel(fontId: number): string {
  return `.message-line[data-font="${fontId}"]:not(.theirs)`;
}

function fontTheirsLineSel(fontId: number): string {
  return (
    `.message-line[data-font="${fontId}"].theirs, ` + `.weq-forward-row[data-font="${fontId}"]`
  );
}

/**
 * Inject CSS rules for one bubble skin.  No-op if already injected.
 * Mirror of dressSkin.ts bubbleRules(), but scoped to data-bubble attribute.
 */
export function injectBubbleCss(skin: MessageBubbleSkin, staticOnly = false) {
  return acquireDecorationStyle(`bubble:${skin.itemId}${staticOnly ? ':base' : ''}`, (resource) => {
    const metrics = bubbleMetrics(skin);
    const { slice, width, minWidth, minHeight, imageUrl } = metrics;
    const sel = bubbleSel(skin.itemId);
    const theirsSel = theirsBubbleSel(skin.itemId);
    // `sel` 是逗号选择器列表,`::after` 不能直接往上拼 —— 那样只会加到最后一项目上,
    // 前面那项会命中真实元素(见 lineContentSel 的历史坑)。用带 suffix 的版本展开。
    const overlaySel = lineContentSel('bubble', skin.itemId, '::after');

    // 动效叠加层的帧图中间通常镂空，静态底图始终单独绘制。
    const frameCount = skin.animationFrameCount ?? 0;
    const frameTimeMs = skin.animationFrameTimeMs ?? 0;
    const hasFrameAnim = validDecorationFrames(frameCount) && frameTimeMs;
    const frameAnim =
      !staticOnly && hasFrameAnim
        ? bubbleFrameAnimationCss(skin.itemId, frameCount, frameTimeMs, skin.animationRepeat ?? 0)
        : null;

    resource.image(imageUrl);

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
      bubbleContentPaddingCss(metrics),
      `  min-width: ${minWidth};`,
      `  min-height: ${minHeight};`,
      `}`,
      bubbleContentAlignmentCss(sel),
      bubbleGroupSpacingCss(skin, sel),
      fractionalBubbleBase(metrics, sel),
    ];

    // 遮罩只作用于独立的字体绘制层，不裁掉气泡前景装饰。
    rules.push(
      fxClipMaskCss(lineContentSel('bubble', skin.itemId, ` > .${FONT_FX_LAYER_CLASS}`), {
        imageUrl,
        slice,
        width,
      }),
    );

    // 我方/非镜像侧的动效叠加层(先于镜像规则注入,对方的同名选择器靠后覆盖)。
    // 这里先不挂 animation —— 等所有帧图片预加载完再开播,避免第一圈逐帧闪烁。
    if (frameAnim) {
      rules.push(
        ninePatchLayer(metrics, overlaySel, {
          imageUrl: dressBubbleFrameUrl(skin.itemId, 1),
          zIndex: BUBBLE_FRAME_Z_INDEX,
        }),
      );
    }

    // 对方消息只镜像底图和前景，文字保持正常方向。
    rules.push(
      `${theirsSel} {`,
      `  border-image-source: none;`,
      `}`,
      ninePatchLayer(metrics, theirsBubbleSel(skin.itemId, '::before'), {
        imageUrl,
        zIndex: -2,
        mirror: true,
      }),
    );

    if (frameAnim) {
      rules.push(
        ninePatchLayer(metrics, theirsBubbleSel(skin.itemId, '::after'), {
          imageUrl: dressBubbleFrameUrl(skin.itemId, 1),
          zIndex: BUBBLE_FRAME_Z_INDEX,
          mirror: true,
        }),
      );
    }

    rules.push(
      bubbleMenuHighlightCss(`.message-line[data-bubble="${skin.itemId}"]`, skin.textColor),
    );

    // 文字色受限的气泡：链接 / @提及不再标蓝（会和气泡文字色冲突），改为继承气泡色 + 下划线。
    if (bubbleRestrictsTextColor(skin.textColor) || skin.linkColor) {
      rules.push(bubbleLinkMentionRules(sel, skin.linkColor));
    }

    resource.append(rules.join('\n'));

    if (frameAnim) {
      // 先注入静态帧，等全部帧图片预加载完再开启动画，避免帧未缓存时的闪烁。
      const frameUrls = Array.from({ length: skin.animationFrameCount! }, (_, i) =>
        dressBubbleFrameUrl(skin.itemId, i + 1),
      );
      resource.animate(
        frameUrls,
        () =>
          `${overlaySel} { animation: ${frameAnim.animation}; }\n` +
          `${theirsBubbleSel(skin.itemId, '::after')} { animation: ${frameAnim.animation}; }\n` +
          `@media (prefers-reduced-motion: reduce) { ${overlaySel} { animation: none; } ${theirsBubbleSel(skin.itemId, '::after')} { animation: none; } }`,
      );
    }
  });
}

export function messageFontFamily(fontId: number, deriveVersion: number): string {
  return `weq-message-dress-${fontId}-${deriveVersion}`;
}

export function isMessageFontLoaded(fontId: number, font: FontDerived): boolean {
  const version = font.deriveVersion ?? 0;
  return fontFaces.isLoaded(messageFontFamily(fontId, version), dressFontUrl(fontId, version));
}

/**
 * 逐条消息字体的 CSS（字体 + 它的炫彩帧）。已注入过的（同款同派生版本）直接返回。
 * staticOnly 保持字体与可见性无关，炫彩帧另按可见范围取得并释放。
 * 炫彩规则等整批预热成功后才注入；尺寸属性由 useBubbleFontFx 决定。
 */
export function injectFontCss(fontId: number, font: FontDerived | null, staticOnly = false) {
  const deriveVersion = font?.deriveVersion ?? 0;
  const key = `${fontId}:${deriveVersion}`;
  return acquireDecorationStyle(`font:${key}${staticOnly ? ':static' : ''}`, (resource) => {
    const url = dressFontUrl(fontId, deriveVersion);
    const family = messageFontFamily(fontId, deriveVersion);

    // FontFace 注册成功才算就绪；QQ 字体被 OTS 拒绝时 ready=false，消息行整组回退默认。
    resource.font(family, url);

    const fxSkin = toFontFxSkin(font);
    const rules = [
      fontTextRules(fontSel(fontId), family),
      // 炫彩：规则一直都在，挂不挂属性由渲染侧量完气泡尺寸决定。
    ];
    resource.append(rules.filter(Boolean).join('\n'));

    if (fxSkin && !staticOnly) {
      // 先解码再等属性挂上（属性是量完尺寸才挂的，帧解完码差不多刚好）——
      // 第一圈逐帧解码会肉眼看得出闪，与气泡动效同一个坑。
      const total = fxSkin.fx.variants.reduce((n, v) => n + v.frames.length, 0);
      const frameUrls = Array.from({ length: total }, (_, i) =>
        dressFontFrameUrl(fontId, i + 1, deriveVersion),
      );
      // 这条路径不推迟开播（见上面的说明），所以解码完立刻钉住：属性一挂上就在播，
      // 中间没有「还没开播、可以放心淘汰」的窗口。
      resource.animate(frameUrls, () =>
        fontFxRules(fxSkin, {
          mine: fontMineLineSel(fontId),
          theirs: fontTheirsLineSel(fontId),
        }),
      );
    }
  });
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
export function injectWidgetCss(widget: ResolvedWidget): () => void {
  if (!widget.animated) return () => {};
  return acquireDecorationStyle(`widget:${widget.itemId}`, (resource) => {
    if (!validDecorationFrames(widget.frameCount)) {
      resource.append(
        `${widgetSel(widget.itemId)} { background-image: url("${dressPendantFrameUrl(widget.itemId, 1)}"); background-size: contain; background-repeat: no-repeat; }`,
      );
      return;
    }

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

    resource.append(rules.join('\n'));

    // 先注入静态帧，等全部帧图片预加载完再开启动画，避免帧未缓存时的闪烁。
    const frameUrls = Array.from({ length: widget.frameCount }, (_, i) =>
      dressPendantFrameUrl(widget.itemId, i + 1),
    );
    resource.animate(
      frameUrls,
      () =>
        `${sel} { animation: ${frameAnim.animation}; }\n` +
        `@media (prefers-reduced-motion: reduce) { ${sel} { animation: none; } }`,
    );
  });
}
