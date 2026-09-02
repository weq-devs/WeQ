/**
 * 个性装扮的样式注入 —— 把一款气泡 / 字体翻译成 CSS,塞进一个受管的 `<style>` 节点。
 *
 * 为什么走注入而不是改组件:气泡只是换皮,`messageBubble.tsx` 的 DOM 不需要任何变化。
 * 注入让「有没有装扮」变成纯 CSS 的事 —— 取消装扮就是移掉这个节点,消息列表零重渲染。
 *
 * ## 九宫格怎么落到 CSS
 *
 * QQ 的气泡是 Android 九宫格,对应 CSS 的 `border-image`。切片参数由 service 侧探测
 * (见 bubble_skin.ts,那里有 slice 公式的坑),这里只负责换算和拼串。
 *
 * 已实测确认 `border-image` 的输出与手工九宫格(4 角原尺寸 + 4 边单向拉伸 + 中心双向
 * 拉伸)逐像素一致,所以不需要为九宫格铺 9 个 DOM 节点。
 *
 * 三个必须注意的点:
 *
 *  1. **`border-width` 必须是 0,厚度单独由 `border-image-width` 给。**
 *     素材的内容内边距小于四角固定区(实测 npTc: padding L40/R40/T32/B32 对
 *     slice L64/T55/R62/B55),即 QQ 的设计里文字本来就会「伸进」角落的装饰区。
 *     若用真 border 撑开,内容会被挤到拉伸带以内,气泡看着会胖一圈。
 *
 *  2. **动效款是「静态底 + APNG 叠加」,不是二选一。**
 *     实测 2078642 的 `animation-all.png` 只有几颗淡星星,气泡本体在 `static-all.png`
 *     里 —— 只贴动效层会得到一个几乎空白的气泡。所以静态层画在元素自身,动效层叠在
 *     `::after` 上(`.message-content` 上没有既有伪元素,不冲突)。
 *
 *  3. **必须给 min-width / min-height。** 小于四角固定区之和的尺寸会让对角切片互相
 *     挤压,浏览器按比例压缩,气泡就变形了。
 *
 * 素材是移动端 2x 的,网页按 {@link BUBBLE_SCALE} 缩。slice 是源图坐标所以不缩,只缩
 * border-image-width / padding / min-size。
 *
 * ## 右键高亮
 *
 * `chat.css` 的 `.context-active` 靠改 `background` 提示选中,但 border-image 画在
 * background 之上,纯色底会被完全盖住。所以装扮生效时改用一圈 outline 提示 —— 视觉上
 * 仍然明确,又不跟贴图打架。
 */

import type { ResolvedWidget } from '@weq/service';
import { dressBubbleUrl, dressBubbleFrameUrl, dressPendantFrameUrl, dressUrl } from './resourceUrl';

/** 与 service 的 BubbleSkin 同构(渲染侧用得到的部分)。 */
export interface BubbleSkinCss {
  itemId: number;
  slice: { left: number; top: number; right: number; bottom: number };
  imageSize: { w: number; h: number };
  textColor: string;
  /** 静态底图 CDN 直链。走本地文件时为空串,看 {@link localFile}。 */
  staticUrl: string;
  /**
   * 有值表示这款是走 protocol 兜底装的,九宫格是本地 PNG(路径在主进程,这里只需知道
   * 有没有)。此时要走 `weq-media://dressbubble` —— `dress` 那支有 host 白名单。
   */
  localFile: string | null;
  /** 动效叠加层 url(APNG)。没有动效版本时为 null。 */
  animationUrl: string | null;
  /**
   * 整泡帧动画的帧数(见 service 的 BubbleSkin.animationFrameCount)。有值时
   * {@link bubbleRules} 生成 `@keyframes` 逐帧切换 border-image-source,取代
   * {@link animationUrl} 那套单张 APNG 叠加层。
   */
  animationFrameCount?: number;
  /** 每帧停留时长(ms)。 */
  animationFrameTimeMs?: number;
  /** 循环次数,0 视为无限循环。 */
  animationRepeat?: number;
}

export interface FontSkinCss {
  itemId: number;
  /** 字体文件的 url(weq-media://dressfont?id=…)。 */
  fontUrl: string;
}

/** 生效的挂件在消息头像上的叠加层选择器。 */
function pendantSelector(scope: DressScope): string {
  return scope === 'all'
    ? '.message-line .weq-avatar-pendant-img, .weq-forward-row .weq-avatar-pendant-img'
    : '.message-line.mine .weq-avatar-pendant-img';
}

/** 装扮作用范围。与 service 的 DressScope 同构。 */
export type DressScope = 'mine' | 'all';

/** 素材是 2x,网页按半尺寸贴才是正常观感。 */
const BUBBLE_SCALE = 0.5;

/**
 * 纵向内边距 ÷ 切片厚度。
 *
 * 取自官方 `.9.png` 的 npTc chunk(唯一能拿到权威 padding 的来源,immersive 分发的 PNG
 * 把 npTc 剥掉了):实测 2078642 是 padding T32/B32 对 slice T55/B55,即 ≈0.58,取 0.6。
 *
 * **横向不用这个比例** —— 见 {@link bubbleRules} 里 padding 那行的说明。
 */
const PAD_RATIO_Y = 0.6;

const STYLE_ID = 'weq-dress-skin';

/** chat.css 里已声明「自带外观、不要气泡底」的消息类型(贴纸 / 独图 / 卡片 / 语音条)。 */
const BUBBLE_CONTENT_EXCLUSIONS =
  ':not(.sticker-only):not(.markdown-image-only):not(.qq-card-only):not(.qq-voice-only)';

/**
 * 装扮生效的消息气泡选择器。
 *
 * scope 决定作用到谁:`mine` 只管自己的消息(手 Q 语义),`all` 连对方的一起。
 */
function bubbleSelector(scope: DressScope): string {
  const line = scope === 'all' ? '.message-line' : '.message-line.mine';
  return `${line} .message-content${BUBBLE_CONTENT_EXCLUSIONS}`;
}

/**
 * 对方消息的气泡选择器。
 *
 * QQ 的九宫格素材按「自己的右侧气泡」绘制(尖角/装饰朝左);放在左侧的对方消息上
 * 必须左右镜像,尖角才朝右指向会话中心。所以 scope=all 时对 `.message-line.theirs`
 * 额外注入一组镜像规则。
 */
function theirsBubbleSelector(): string {
  return `.message-line.theirs .message-content${BUBBLE_CONTENT_EXCLUSIONS}`;
}

/** 四舍五入到 2 位小数,避免 0.5 缩放产生一长串浮点尾巴。 */
function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/**
 * 整泡帧动画的 `@keyframes` + `animation` 简写。与 msgDecorationStyle.ts 的同名逻辑
 * 镜像(那边按 data-bubble 注入、这边按「当前生效装扮」注入,两条渲染路径本就是分开的,
 * 见文件头)。`steps(1)` 让每帧撑满自己的时间段,而不是按不可插值属性的默认「过半才切」
 * 语义把每帧显示时长砍半。
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

/** 气泡是否「限制」了文字颜色。 */
export function bubbleRestrictsTextColor(textColor: string): boolean {
  // service 侧解析（bubble_skin.ts 的 resolveTextColor）：只有这款气泡自己规定颜色（material
  // color / 不透明纯色填充推断）才是具体色值；回退主题正文色时是 var()，不算限制。
  return !textColor.trim().startsWith('var(');
}

/** 文字色受限的气泡里，链接 / @提及不标蓝，一律继承气泡文字色、用下划线区分。 */
export function bubbleLinkMentionRules(sel: string): string {
  // sel 可能是逗号分隔的多选择器（msgDecorationStyle 的 data-bubble 路径同时选
  // .message-line 和 .weq-forward-row）。后缀必须展开到每一项——CSS 的 `a, b c` 只会给
  // 最后一项加后缀，直接拼接会让前面那项变成选中整个 .message-content，整条消息都被下划线。
  const sels = sel.split(',').map((s) => s.trim());
  const link = sels.map((s) => `${s} .qq-link`).join(',\n');
  const hover = sels.map((s) => `${s} .qq-link:hover`).join(',\n');
  const at = sels.map((s) => `${s} .qq-at-element`).join(',\n');
  return [
    `${link},\n${hover},\n${at} {`,
    `  color: inherit;`,
    `  text-decoration-color: currentColor;`,
    `}`,
    `${at} {`,
    `  text-decoration: underline;`,
    `  text-underline-offset: 2px;`,
    `}`,
  ].join('\n');
}

/** 一款气泡的九宫格几何量 + 静态底图 —— 聊天渲染与本地预览共用同一份计算。 */
interface BubbleMetrics {
  frameAnim: { keyframes: string; animation: string } | null;
  /** 静态底图 url(本地九宫格 PNG / CDN 直链 / 帧动画第 1 帧,见 bubbleImageUrl)。 */
  imageUrl: string;
  slice: string;
  width: string;
  topPad: string;
  rightPad: string;
  bottomPad: string;
  minWidth: string;
  minHeight: string;
}

function bubbleMetrics(skin: BubbleSkinCss): BubbleMetrics {
  const { left, top, right, bottom } = skin.slice;

  // 贴图向内绘制的厚度。slice 是源图像素,乘 scale 得到 CSS 像素。
  const wTop = top * BUBBLE_SCALE;
  const wRight = right * BUBBLE_SCALE;
  const wBottom = bottom * BUBBLE_SCALE;
  const wLeft = left * BUBBLE_SCALE;

  const slice = `${top} ${right} ${bottom} ${left} fill`;
  const width = `${px(wTop)} ${px(wRight)} ${px(wBottom)} ${px(wLeft)}`;

  const frameAnim =
    skin.animationFrameCount && skin.animationFrameTimeMs
      ? frameAnimationCss(
          skin.itemId,
          skin.animationFrameCount,
          skin.animationFrameTimeMs,
          skin.animationRepeat ?? 0,
        )
      : null;

  // 纵向 padding:基础按 0.6 比例,不对称时用差值补偿。
  // top 小(装饰少) → 需要增大 topPad 把文字往下推离顶部
  // bottom 小 → 需要增大 bottomPad 把文字往上推离底部
  const avgSlice = (top + bottom) / 2;
  const topDiff = avgSlice - top; // top 小时为正,需要补偿
  const bottomDiff = avgSlice - bottom;
  const topPad = px(wTop * PAD_RATIO_Y + topDiff * BUBBLE_SCALE * 0.5);
  const bottomPad = px(wBottom * PAD_RATIO_Y + bottomDiff * BUBBLE_SCALE * 0.5);

  return {
    frameAnim,
    imageUrl: bubbleImageUrl(skin),
    slice,
    width,
    // 横向内边距必须盖满整条左右切片,文字只能落在中间那 2px 的拉伸区上。
    rightPad: px(Math.max(wLeft, wRight)),
    topPad,
    bottomPad,
    minWidth: px((left + right) * BUBBLE_SCALE),
    minHeight: px((top + bottom) * BUBBLE_SCALE),
  };
}

/**
 * 把一款气泡的核心九宫格规则涂到给定的元素选择器上。
 *
 * 聊天渲染(bubbleRules)与「已装」列表的本地预览(bubblePreviewCss)共用这一份 ——
 * 预览和真实消息用的是同一套几何,不会出现「卡片里好看、发出来是另一回事」的偏差。
 * `animate = false` 用于静态预览(只贴第一帧底图,不播循环动效)。
 */
function baseBubbleRule(
  skin: BubbleSkinCss,
  m: BubbleMetrics,
  sel: string,
  animate = true,
): string {
  return [
    `${sel} {`,
    `  position: relative;`,
    // 动效层靠负层级压到文字下面,而负层级只在**层叠上下文内部**才是「压到本元素背景之上」;
    // 不隔离的话它会逃到最近的祖先上下文里,反而跑到静态贴图底下(甚至被行背景整个盖掉)。
    // 用 isolation 而不是 z-index:0 —— 后者会连带改掉这个气泡相对同级元素的层级。
    `  isolation: isolate;`,
    `  background: transparent;`,
    `  color: ${skin.textColor};`,
    `  border-style: solid;`,
    `  border-width: 0;`,
    `  border-image-source: url("${m.imageUrl}");`,
    `  border-image-slice: ${m.slice};`,
    `  border-image-width: ${m.width};`,
    `  border-image-repeat: stretch;`,
    `  border-radius: 0;`,
    m.frameAnim && animate ? `  animation: ${m.frameAnim.animation};` : '',
    // 纵向 padding:让文字对齐拉伸源。top < bottom 时拉伸源偏上,减少上 padding;
    // top > bottom 时拉伸源偏下,增加上 padding。公式源自九宫格恒等式(bubble_skin.ts:323)。
    `  padding: ${m.topPad} ${m.rightPad} ${m.bottomPad};`,
    `  min-width: ${m.minWidth};`,
    `  min-height: ${m.minHeight};`,
    `}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function bubbleRules(skin: BubbleSkinCss, scope: DressScope): string {
  const sel = bubbleSelector(scope);
  const theirsSel = scope === 'all' ? theirsBubbleSelector() : null;
  const m = bubbleMetrics(skin);

  const rules = [m.frameAnim?.keyframes ?? '', baseBubbleRule(skin, m, sel)];

  // 对方消息镜像:同一张素材直接放左侧,尖角/装饰会朝外,看起来「反的」。QQ 自己
  // 就是把素材左右镜像后贴到对方消息上的。不能对整个 .message-content 做
  // scaleX(-1) —— 文字会跟着镜像;所以静态底/帧动画挪到 ::before 上翻转,文字
  // 留在元素自身不动。
  if (theirsSel) {
    rules.push(
      // 元素本体不再贴底(镜像后的贴图由 ::before 承担);帧动画的 keyframes 会
      // 重写 border-image-source,必须把元素动画一并关掉,否则帧图会盖回来。
      `${theirsSel} {`,
      `  border-image-source: none;`,
      m.frameAnim ? `  animation: none;` : '',
      `}`,
      `${theirsSel}::before {`,
      `  content: "";`,
      `  position: absolute;`,
      `  inset: 0;`,
      `  z-index: -1;`,
      `  pointer-events: none;`,
      `  border-style: solid;`,
      `  border-width: 0;`,
      `  border-image-source: url("${m.imageUrl}");`,
      `  border-image-slice: ${m.slice};`,
      `  border-image-width: ${m.width};`,
      `  border-image-repeat: stretch;`,
      `  border-radius: 0;`,
      `  transform: scaleX(-1);`,
      m.frameAnim ? `  animation: ${m.frameAnim.animation};` : '',
      `}`,
    );
  }

  // 减少动态效果偏好:定格在第一帧,不循环切换。
  if (m.frameAnim) {
    rules.push(
      `@media (prefers-reduced-motion: reduce) {`,
      `  ${sel} { animation: none; }`,
      theirsSel ? `  ${theirsSel}::before { animation: none; }` : '',
      `}`,
    );
  }

  // 动效层:同一套 slice/width,叠在静态底之上。APNG 由浏览器自己播,无需 keyframes。
  // z-index 为负是为了压在**文字**下面 —— 绝对定位的伪元素默认画在在流内容之上,
  // 不给层级的话动效会糊住消息正文。父元素 isolation:isolate 保证这个负值不外溢。
  if (skin.animationUrl) {
    rules.push(
      `${sel}::after {`,
      `  content: "";`,
      `  position: absolute;`,
      `  inset: 0;`,
      `  z-index: -1;`,
      `  pointer-events: none;`,
      `  border-style: solid;`,
      `  border-width: 0;`,
      `  border-image-source: url("${dressUrl(skin.animationUrl)}");`,
      `  border-image-slice: ${m.slice};`,
      `  border-image-width: ${m.width};`,
      `  border-image-repeat: stretch;`,
      `}`,
    );
    if (theirsSel) {
      rules.push(`${theirsSel}::after { transform: scaleX(-1); }`);
    }
  }

  // 右键选中:贴图盖住了 background,改用 outline 提示。
  const activeLine = scope === 'all' ? '.message-line' : '.message-line.mine';
  rules.push(
    `${activeLine} .message-bubble.context-active .message-content {`,
    `  background: transparent;`,
    `  outline: 2px solid var(--weq-accent-effective, #12a8ff);`,
    `  outline-offset: -1px;`,
    `}`,
  );

  // 文字色受限的气泡：链接 / @提及不再标蓝（会和气泡文字色冲突），改为继承气泡色 + 下划线。
  if (bubbleRestrictsTextColor(skin.textColor)) {
    rules.push(bubbleLinkMentionRules(sel));
  }

  return rules.filter(Boolean).join('\n');
}

/**
 * 独立气泡预览的九宫格 CSS —— 给非聊天容器用(目前是「已装」列表里没有商城预览图的
 * 那批气泡,如消息 40801 逐条自动装的款,素材是本地九宫格 PNG)。
 *
 * 与 bubbleRules 共用 bubbleMetrics / baseBubbleRule,几何完全一致;静态预览只画
 * 第一帧,不带循环动效。sel 是调用方自己的容器选择器,样式注入由调用方负责。
 */
export function bubblePreviewCss(skin: BubbleSkinCss, sel: string): string {
  return baseBubbleRule(skin, bubbleMetrics(skin), sel, false);
}

/**
 * 生效挂件的逐帧动画 CSS —— 与 msgDecorationStyle 的 widgetFrameAnimationCss 同构,
 * 只是选择器换成按「作用范围」而不是按 data-widget 属性(生效挂件没有 per-message
 * 的那条 40801 装饰,所有消息共用一款)。背景图逐帧切换,`steps(1)` 让每帧撑满自己的
 * 时间段而不是按不可插值属性的默认「过半才切」语义把显示时长砍半。
 */
function widgetPendantRules(widget: ResolvedWidget, scope: DressScope): string {
  if (!widget.animated) return '';
  const name = `weq-widgetframe-${widget.itemId}`;
  const step = 100 / widget.frameCount;
  const stops = Array.from({ length: widget.frameCount }, (_, i) => {
    const pct = Math.round(Math.min(i * step, 100) * 100) / 100;
    return `  ${pct}% { background-image: url("${dressPendantFrameUrl(widget.itemId, i + 1)}"); }`;
  });
  const keyframes = [`@keyframes ${name} {`, ...stops, `}`].join('\n');
  const duration = widget.frameCount * widget.frameTimeMs;
  const iterations = widget.repeat > 0 ? widget.repeat : 'infinite';
  const sel = pendantSelector(scope);
  return [
    keyframes,
    `${sel} {`,
    `  background-image: url("${dressPendantFrameUrl(widget.itemId, 1)}");`,
    `  background-size: contain;`,
    `  background-position: center;`,
    `  background-repeat: no-repeat;`,
    `  animation: ${name} ${duration}ms steps(1) ${iterations};`,
    `}`,
    `@media (prefers-reduced-motion: reduce) {`,
    `  ${sel} { animation: none; }`,
    `}`,
  ].join('\n');
}

/**
 * 生效挂件的全部帧 url(逐帧预加载用)。
 */
function widgetFrameUrls(widget: ResolvedWidget | null): string[] {
  if (!widget?.animated) return [];
  return Array.from({ length: widget.frameCount }, (_, i) =>
    dressPendantFrameUrl(widget.itemId, i + 1),
  );
}

function fontRules(font: FontSkinCss, scope: DressScope): string {
  // @font-face 不在这里声明 —— 字体经 FontFace API 预加载后注册进 document.fonts
  // (见 preloadFont)。那样字形在样式落地前就绪,不会触发 swap 的二次重排。
  return [
    // fallback 必须留着 —— QQ 的装扮字体多是子集化的,缺字要能回退到正文字体。
    // 这里**不能**用 `inherit`:CSS 不允许 inherit 出现在逗号列表里,整条声明会被
    // 浏览器整体丢弃(字体因此永远不生效,且控制台不报错)。要写成真实的字体族名。
    `${bubbleSelector(scope)} {`,
    `  font-family: "${fontFamilyFor(font.itemId)}", var(--im-font-body, Inter), ui-sans-serif, system-ui, sans-serif;`,
    `}`,
  ].join('\n');
}

/** `@font-face` 的 family 名 —— 与 service 侧 dress_shared_cache.fontFamilyFor 的约定必须一致。 */
function fontFamilyFor(itemId: number): string {
  return `weq-dress-${itemId}`;
}

/**
 * 气泡静态底图的 url。整泡帧动画取第 1 帧(见 {@link frameAnimationCss} —— 那套
 * keyframes 会在动画开始后接管 border-image-source,这里给的是初始/无动画兜底值)。
 * 没有帧动画时按原规则:本地兜底装的走 dressbubble,CDN 直链走 dress。
 */
function bubbleImageUrl(skin: BubbleSkinCss): string {
  if (skin.animationFrameCount) return dressBubbleFrameUrl(skin.itemId, 1);
  return skin.localFile ? dressBubbleUrl(skin.itemId) : dressUrl(skin.staticUrl);
}

/**
 * 预热一张图。**失败也 resolve** —— 预热只为避开二次重排,不是能否渲染的前提;
 * 拿不到就照常注入,由 border-image 自己空着(与预热之前的行为一致)。
 */
function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

/** 已注册进 document.fonts 的那个 face。换字体时要先撤掉,否则会越积越多。 */
let registeredFace: FontFace | null = null;

/** 撤掉已注册的 face。取消字体时必须调,否则它会一直赖在 document.fonts 里。 */
function unregisterFont(): void {
  if (!registeredFace) return;
  document.fonts.delete(registeredFace);
  registeredFace = null;
}

/**
 * 加载字体并注册进 `document.fonts`。
 *
 * 走 FontFace API 而不是 CSS 的 `@font-face`,是为了能 **await 到字形真正就绪**:
 * `@font-face` 是声明式的,注入那一刻字体还在下载,`font-display: swap` 会先用兜底
 * 字体排一遍、字体到了再排一遍 —— 消息列表长的时候这第二遍很显眼。
 *
 * 不传 format 描述符的理由同原 CSS 注释:安装层把字体一律存成 `.ttf`,但 QQ 的装扮字体
 * 有一部分其实是 CFF/OTF 外壳,声明成 truetype 会被 Chrome 判定格式不符而**静默**跳过。
 */
async function preloadFont(font: FontSkinCss): Promise<void> {
  const family = fontFamilyFor(font.itemId);
  if (registeredFace?.family === family) return;

  unregisterFont();

  try {
    const face = await new FontFace(family, `url("${font.fontUrl}")`).load();
    document.fonts.add(face);
    registeredFace = face;
  } catch {
    // 字体坏了 / 文件丢了:静默跳过,CSS 里的 fallback 链会接住。
  }
}

/**
 * 应用(或清除)当前的装扮。三个 skin 都为 null 时移除样式节点,回到默认外观。
 *
 * **同步的,不等资源** —— 进主界面时的首次注入走这条(资源多半已在磁盘缓存里,
 * 等它反而推迟首屏)。切换装扮请走 {@link applyDressSkinPreloaded}。
 *
 * 字体例外:必须**触发**注册(见下面的 preloadFont 调用),只是不 await。因为
 * `@font-face` 已经不在注入的 CSS 里了 —— family 靠 FontFace API 注册进
 * document.fonts,不注册的话 `font-family: "weq-dress-<id>"` 解析不出来,浏览器
 * 静默回退到兜底字体,表现就是「气泡生效了但字体没生效」。
 */
export function applyDressSkin(
  bubble: BubbleSkinCss | null,
  font: FontSkinCss | null,
  widget: ResolvedWidget | null,
  scope: DressScope = 'mine',
): void {
  // 不 await:注册完成后 document.fonts 变化会让浏览器自己重绘用到该 family 的文本,
  // 不需要我们再动 CSS。放在写 CSS 之前只是为了让下载早开始一点。
  if (font) void preloadFont(font);
  else unregisterFont();

  const existing = document.getElementById(STYLE_ID);

  if (!bubble && !font && !widget) {
    existing?.remove();
    return;
  }

  const css = [
    bubble ? bubbleRules(bubble, scope) : '',
    font ? fontRules(font, scope) : '',
    widget ? widgetPendantRules(widget, scope) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const node = existing ?? document.createElement('style');
  if (!existing) {
    node.id = STYLE_ID;
    document.head.appendChild(node);
  }
  // 内容没变就别写 —— 赋值 textContent 会让浏览器重算整张样式表,而
  // getState 的每次 invalidate 都会走到这里(清单对象换了引用但内容常常一样)。
  if (node.textContent !== css) node.textContent = css;
}

/**
 * 先把资源拉齐,再注入样式。切换装扮时用这条。
 *
 * 分两步的原因:注入瞬间图片还没解码、字体还没下载,消息列表会先按兜底外观排一遍、
 * 资源到齐再排一遍。列表长的时候这第二遍就是肉眼可见的卡顿。先 await 资源,注入
 * 就只剩一次重排,而调用方可以在这段等待期间显示加载态。
 *
 * 预热失败不阻塞注入(见 {@link preloadImage}) —— 装扮是锦上添花,不该因为一张图
 * 拉不到就卡在加载态里。
 */
export async function applyDressSkinPreloaded(
  bubble: BubbleSkinCss | null,
  font: FontSkinCss | null,
  widget: ResolvedWidget | null,
  scope: DressScope = 'mine',
): Promise<void> {
  await Promise.all(
    [
      bubble ? preloadImage(bubbleImageUrl(bubble)) : null,
      bubble?.animationUrl ? preloadImage(dressUrl(bubble.animationUrl)) : null,
      font ? preloadFont(font) : null,
      // 挂件帧是本地 protocol 文件,首帧以后基本秒达;但首帧没解码就开播仍然会闪,
      // 所以逐帧预加载完再注入(与 msgDecorationStyle 的 preloadImages 同思路)。
      ...widgetFrameUrls(widget).map((url) => preloadImage(url)),
    ].filter(Boolean),
  );

  applyDressSkin(bubble, font, widget, scope);
}
