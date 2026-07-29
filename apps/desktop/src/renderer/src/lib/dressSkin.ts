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

import { dressBubbleUrl, dressUrl } from './resourceUrl';

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
 * 内容内边距 ÷ 切片厚度。
 *
 * 取自官方 `.9.png` 的 npTc chunk(唯一能拿到权威 padding 的来源,immersive 分发的 PNG
 * 把 npTc 剥掉了):实测 2078642 是 padding L40/R40/T32/B32 对 slice L64/R62/T55/B55,
 * 即横向 ≈0.63、纵向 ≈0.58。取 0.6 一档,与手 Q 观感基本吻合。
 */
const PAD_RATIO = 0.6;

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

  const rules = [
    `${sel} {`,
    `  position: relative;`,
    `  background: transparent;`,
    `  color: ${skin.textColor};`,
    `  border-style: solid;`,
    `  border-width: 0;`,
    `  border-image-source: url("${skin.localFile ? dressBubbleUrl(skin.itemId) : dressUrl(skin.staticUrl)}");`,
    `  border-image-slice: ${slice};`,
    `  border-image-width: ${width};`,
    `  border-image-repeat: stretch;`,
    `  border-radius: 0;`,
    `  padding: ${px(Math.min(wTop, wBottom) * PAD_RATIO)} ${px(Math.min(wLeft, wRight) * PAD_RATIO)};`,
    `  min-width: ${px((left + right) * BUBBLE_SCALE)};`,
    `  min-height: ${px((top + bottom) * BUBBLE_SCALE)};`,
    `}`,
  ];

  // 动效层:同一套 slice/width,叠在静态底之上。APNG 由浏览器自己播,无需 keyframes。
  if (skin.animationUrl) {
    rules.push(
      `${sel}::after {`,
      `  content: "";`,
      `  position: absolute;`,
      `  inset: 0;`,
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
  const family = `weq-dress-${font.itemId}`;
  return [
    `@font-face {`,
    `  font-family: "${family}";`,
    // **不写 `format(...)`**:安装层把字体一律存成 `.ttf`,但 QQ 的装扮字体里有一部分
    // 其实是 CFF/OTF 外壳。声明成 truetype 时 Chrome 判定格式不符会直接跳过这个 src,
    // 而且不报错。省掉 format 让它自己嗅探。
    `  src: url("${font.fontUrl}");`,
    `  font-display: swap;`,
    `}`,
    // fallback 必须留着 —— QQ 的装扮字体多是子集化的,缺字要能回退到正文字体。
    // 这里**不能**用 `inherit`:CSS 不允许 inherit 出现在逗号列表里,整条声明会被
    // 浏览器整体丢弃(字体因此永远不生效,且控制台不报错)。要写成真实的字体族名。
    `${bubbleSelector(scope)} {`,
    `  font-family: "${family}", var(--im-font-body, Inter), ui-sans-serif, system-ui, sans-serif;`,
    `}`,
  ].join('\n');
}

/**
 * 应用(或清除)当前的装扮。两个 skin 都为 null 时移除样式节点,回到默认外观。
 */
export function applyDressSkin(
  bubble: BubbleSkinCss | null,
  font: FontSkinCss | null,
  scope: DressScope = 'mine',
): void {
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
  node.textContent = css;
}
