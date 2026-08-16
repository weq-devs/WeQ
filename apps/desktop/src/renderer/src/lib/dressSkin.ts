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

import { dressBubbleUrl, dressBubbleFrameUrl, dressUrl } from './resourceUrl';

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

/**
 * 装扮生效的消息气泡选择器。
 *
 * `:not(…)` 那串排除的是 chat.css 里已经声明「自带外观、不要气泡底」的几类
 * (贴纸 / 独图 / 卡片 / 语音条),给它们套气泡会把卡片框在一个不该有的框里。
 *
 * scope 决定作用到谁:`mine` 只管自己的消息(手 Q 语义),`all` 连对方的一起。
 */
function bubbleSelector(scope: DressScope): string {
  const line = scope === 'all' ? '.message-line' : '.message-line.mine';
  return (
    `${line} .message-content` +
    ':not(.sticker-only):not(.markdown-image-only):not(.qq-card-only):not(.qq-voice-only)'
  );
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

function bubbleRules(skin: BubbleSkinCss, scope: DressScope): string {
  const sel = bubbleSelector(scope);
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

  const rules = [
    frameAnim?.keyframes ?? '',
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
    `  border-image-source: url("${bubbleImageUrl(skin)}");`,
    `  border-image-slice: ${slice};`,
    `  border-image-width: ${width};`,
    `  border-image-repeat: stretch;`,
    `  border-radius: 0;`,
    frameAnim ? `  animation: ${frameAnim.animation};` : '',
    // 横向内边距必须**盖满整条左右切片**,文字只能落在中间那 2px 的拉伸区上。
    // 用 npTc 那个 0.6 会让文字压进角落的装饰画(实测「简约鲸鱼」那款,鲸鱼和气泡尖
    // 都在左右切片里,文字直接骑上去)。纵向按各自切片厚度的 0.6 + 4px 安全边距,
    // 避免文字冲进装饰区或因行高下沉超出气泡边界。
    `  padding: ${px(wTop * PAD_RATIO_Y + 8)} ${px(Math.max(wLeft, wRight))} ${px(wBottom * PAD_RATIO_Y + 4)};`,
    `  min-width: ${px((left + right) * BUBBLE_SCALE)};`,
    `  min-height: ${px((top + bottom) * BUBBLE_SCALE)};`,
    `}`,
  ];

  // 减少动态效果偏好:定格在第一帧,不循环切换。
  if (frameAnim) {
    rules.push(`@media (prefers-reduced-motion: reduce) {`, `  ${sel} { animation: none; }`, `}`);
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
      `  border-image-slice: ${slice};`,
      `  border-image-width: ${width};`,
      `  border-image-repeat: stretch;`,
      `}`,
    );
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

  return rules.filter(Boolean).join('\n');
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

/** `@font-face` 的 family 名 —— 与 service 侧 dress_install 的约定必须一致。 */
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
 * 应用(或清除)当前的装扮。两个 skin 都为 null 时移除样式节点,回到默认外观。
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
  scope: DressScope = 'mine',
): void {
  // 不 await:注册完成后 document.fonts 变化会让浏览器自己重绘用到该 family 的文本,
  // 不需要我们再动 CSS。放在写 CSS 之前只是为了让下载早开始一点。
  if (font) void preloadFont(font);
  else unregisterFont();

  const existing = document.getElementById(STYLE_ID);

  if (!bubble && !font) {
    existing?.remove();
    return;
  }

  const css = [bubble ? bubbleRules(bubble, scope) : '', font ? fontRules(font, scope) : '']
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
  scope: DressScope = 'mine',
): Promise<void> {
  await Promise.all(
    [
      bubble ? preloadImage(bubbleImageUrl(bubble)) : null,
      bubble?.animationUrl ? preloadImage(dressUrl(bubble.animationUrl)) : null,
      font ? preloadFont(font) : null,
    ].filter(Boolean),
  );

  applyDressSkin(bubble, font, scope);
}
