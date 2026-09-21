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
 *  2. **动效是「底图 + 叠加层」两层九宫格。** ZIP 里的 `bubbleframe/*.9.png` 中间
 *     是镂空的 —— 它只画上下两端的动效装饰(实测 2116371 的 12 帧在 fill 区 0/4
 *     不透明,而已装库里 55 款动效气泡有 52 款如此)。所以静态底图
 *     `aio_user_bg_nor.9.png` 恒常贴在元素本体上,帧图另起一层(`::after`,由 CSS
 *     `@keyframes` 逐帧切换 `border-image-source`)叠在上面。把帧图当成整泡图去
 *     **替换**底图,气泡本体就会整块透明 —— 这是修掉过的老 bug。
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
 *
 * ## 文字颜色的优先级
 *
 * 气泡的 config.json 会声明一个文字色(「这个气泡上的字应该是白的」),但**字体自己的
 * 声明高于它** —— 顺序是：
 *
 *   1. 字体文件自带的颜色（`brsh`/`cglf` 编译出的 `COLR`/`CPAL`）—— 字体说这个字形是
 *      什么颜色就是什么颜色，气泡改不动它（COLR 图层直接指定了调色板项，CSS 的
 *      `color` 根本不参与；只有调色板里那种「用前景色」的特殊项才会被 `color` 影响，
 *      而我们的产物不用那一项）。
 *   2. 气泡声明的文字色（{@link BubbleSkinCss.textColor}）—— 字体没上色的那些字形
 *      （汉字、符号、以及 `cglf` 没圈中的部分）走它。
 *   3. 主题正文色（`var(--weq-fg-primary)`）—— 既不选气泡也不选字体时的兵底。
 *
 * 所以这里的 `color: ${skin.textColor}` 只是第 2 级：它按在 `.message-content` 上，
 * 字体里上过色的字形照样是字体自己的颜色。任何时候都不要把气泡文字色写成
 * `-webkit-text-fill-color` 或带 `!important` 的形式 —— 那会把第 1 级压掉。
 *
 * ## 字体自带的炫彩动画
 *
 * `eimg` 炫彩/场景字体（实测 20405 / 20268）里还夹着多帧 PNG：字体「出现之初」在
 * 气泡里放一次的光效/场景。做法是把帧图层画在气泡内容层的**伪元素**上（我方 `::before`、
 * 对方/转发行 `::after`，见 {@link fontFxRules}），**左上角对齐、原尺寸不缩放不拉伸**；
 * 气泡比所有画布都大就不放 —— 放上去只会被裁掉一大块，只剩半个特效。
 *
 * 层级 = 负 `z-index` + 内容层上的 `isolation: isolate`。负层级只有被隔离在内容层自己的
 * 层叠上下文里，才是「位于气泡底图**之上**、文字**之下**」那一层；少了 isolation 它会逃到
 * 祖先上下文，被气泡底图整个盖住（实测：只看得到从气泡边缘露出的一条）。
 *
 * 范围上 `inset: 0` + `overflow: hidden` 已经裁到气泡盒；挂了装扮气泡时再叠一层同几何的
 * 九宫格遮罩（{@link fxClipMaskCss}）把九宫格圆角外的部分也裁掉，没挂装扮气泡就靠
 * `border-radius: inherit` 跟着主题气泡自己的圆角走。
 *
 * 「放不放、放哪一段」要量完气泡尺寸才知道，所以行元素上的 `data-fontfx="<字体id>-<变体>"`
 * 由渲染侧挂（见 hooks/useBubbleFontFx，值里带字体 id 是为了让同一元素上「生效字体」与
 * 「逐条消息字体」两套规则不互相抢 `@keyframes`）。
 *
 * 与文字色的关系：炫彩是**画在气泡底图之上、文字之下**的一层，所以它盖得住气泡底色，
 * 又不会糊住字。节奏不跟 QQ 的时间轴（见 {@link FONT_FX_FRAME_MS}）。
 */

import type { FontFx, ResolvedWidget } from '@weq/service';
import {
  dressBubbleUrl,
  dressBubbleFrameUrl,
  dressFontFrameUrl,
  dressPendantFrameUrl,
} from './resourceUrl';

/** 与 service 的 BubbleSkin 同构(渲染侧用得到的部分)。 */
export interface BubbleSkinCss {
  itemId: number;
  slice: { left: number; top: number; right: number; bottom: number };
  imageSize: { w: number; h: number };
  textColor: string;
  /**
   * local-only 模型下九宫格恒为本地 PNG(路径在主进程,渲染走
   * `weq-media://dressbubble?id=`,这里只需要知道有值)。
   */
  localFile: string | null;
  /**
   * 整泡帧动画的帧数(见 service 的 BubbleSkin.animationFrameCount)。有值时
   * {@link bubbleRules} 生成 `@keyframes` 逐帧切换**动效叠加层**的 border-image-source。
   */
  animationFrameCount?: number;
  /** 每帧停留时长(ms)。 */
  animationFrameTimeMs?: number;
  /** 循环次数,0 视为无限循环。 */
  animationRepeat?: number;
}

export interface FontSkinCss {
  itemId: number;
  /** 字体文件的 url(weq-media://dressfont?id=…&v=…)。 */
  fontUrl: string;
  /**
   * 产出这份 ttf 的转换链版本（服务侧 DressSharedCache 的 DRESS_DERIVE_VERSION）。
   * 升级后产物被就地重做时它跟着变：① 拼进 url 让浏览器重取；② {@link preloadFont}
   * 据此重新注册 face —— 否则 family 名没变，旧 face 会一直在 `document.fonts` 里赖到下次启动。
   */
  deriveVersion: number;
  /** `eimg` 炫彩帧（按画布尺寸分好组）；没有这个表的字体为 null。 */
  fx: FontFx | null;
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

/** 气泡本体(真正贴九宫格 / 排文字的那个元素,装扮属性都挂在它所在的行上)。 */
const BUBBLE_CONTENT = `.message-content${BUBBLE_CONTENT_EXCLUSIONS}`;

/**
 * 装扮生效的消息行选择器(不带 `.message-content`)。
 *
 * scope 决定作用到谁:`mine` 只管自己的消息(手 Q 语义),`all` 连对方的一起。
 * 渲染侧的 `data-fontfx` 就挂在这种行元素上:伪元素层的位置已经被气泡占着,炫彩要
 * 画在行内部的 `.message-content` 上,所以 CSS 得先选中行、再往下取内容层。
 */
function bubbleLineSelector(scope: DressScope): string {
  return scope === 'all' ? '.message-line' : '.message-line.mine';
}

/**
 * 装扮生效的消息气泡选择器。
 *
 * scope 决定作用到谁:`mine` 只管自己的消息(手 Q 语义),`all` 连对方的一起。
 */
function bubbleSelector(scope: DressScope): string {
  return `${bubbleLineSelector(scope)} ${BUBBLE_CONTENT}`;
}

/**
 * 挂了炫彩帧的**我方**行（帧图层在 `::before`，见 {@link fontFxRules}）。
 *
 * 带上 `[data-fontfx]` 是有意的：九宫格遮罩（{@link fxClipMaskCss}）靠它只作用在真的有
 * 帧的那些行上，没挂帧的消息一个字节也不多注入。
 */
const FX_MINE_LINE = '.message-line.mine[data-fontfx]';

/** 挂了炫彩帧的**对方**行 + 转发行（帧图层在 `::after`，见 {@link fontFxRules}）。 */
const FX_THEIRS_LINE = '.message-line.theirs[data-fontfx], .weq-forward-row[data-fontfx]';

/**
 * 对方消息的气泡选择器。
 *
 * QQ 的九宫格素材按「自己的右侧气泡」绘制(尖角/装饰朝左);放在左侧的对方消息上
 * 必须左右镜像,尖角才朝右指向会话中心。所以 scope=all 时对 `.message-line.theirs`
 * 额外注入一组镜像规则。
 */
function theirsBubbleSelector(): string {
  return `.message-line.theirs ${BUBBLE_CONTENT}`;
}

/** 四舍五入到 2 位小数,避免 0.5 缩放产生一长串浮点尾巴。 */
function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/**
 * 动效叠加层的 `@keyframes` + `animation` 简写。与 msgDecorationStyle.ts 的同名逻辑
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

/**
 * 给一个（可能是逗号列表的）选择器的**每一项**加后缀。
 *
 * CSS 的 `a, b c` 只给最后一项加后缀，直接拼接会让前面那项命中别的元素 ——
 * 历史坑见 bubbleLinkMentionRules。
 */
export function appendToSelectors(sel: string, suffix: string): string {
  return sel
    .split(',')
    .map((s) => `${s.trim()}${suffix}`)
    .join(',\n');
}

/**
 * 炫彩帧的帧时长（ms）—— **160ms/帧（≈6fps，1/4 倍速）**。
 *
 * 我们的视觉标准，不是 QQ 的时间轴：`eimg` 旁边那几张编排表（`scen`/`smap`/`fpid`）
 * 参考太少、收益不成正比，所以不逆向。
 *
 * 曾经拍 40ms（25fps），实际观感是「闪一下就没看清」——素材本身是画得很细的场景/光效，
 * 一帧只给 40ms 等于白画。160ms 是实测能看清每一帧、又不至于拖沓的档位（约 1/4 倍速）；
 * 总时长随帧数（15 帧≈2.4s、30 帧≈4.8s），同一款字体几段动画长短不同是正常的。
 */
const FONT_FX_FRAME_MS = 160;

/** 一款字体的炫彩素材（渲染侧需要的最小集：谁 + 产出它的转换链版本 + 帧几何）。 */
export interface FontFxSkin {
  itemId: number;
  /** 产出这些帧的转换链版本 —— 拼进帧 url，见 {@link dressFontFrameUrl}。 */
  deriveVersion: number;
  fx: FontFx;
}

/** 一段炫彩动画的全部帧 url（按变体分组展开后的全局帧序）。 */
export function fontFxFrameUrls(skin: FontFxSkin | null | undefined): string[] {
  if (!skin) return [];
  const total = skin.fx.variants.reduce((n, v) => n + v.frames.length, 0);
  return Array.from({ length: total }, (_, i) =>
    dressFontFrameUrl(skin.itemId, i + 1, skin.deriveVersion),
  );
}

/**
 * 挑一个变体播 —— 选**装得下这个气泡的最小一段**。
 *
 * `eimg` 里的帧分几段画布（实测 20405 是 350×141/82/76/49/109 五段），客户端按
 * 「文字占几行」挑尺寸合适的那段。我们没有那套编排表，用几何近似：取能覆盖气泡
 * （宽高都不小于气泡）里**面积最小的一段**——它就是最贴尺寸的那张画布。
 *
 * 一段都盖不住（气泡比所有画布都大）→ 返回 null，**不放**：放上去只会被气泡裁掉一大块，
 * 变成半个特效，不如不放。
 *
 * @returns 变体序号（1-based，与 `data-fontfx` 的值一致），没合适的返回 null
 */
export function pickFontFxFariant(fx: FontFx, w: number, h: number): number | null {
  let best: number | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (let index = 0; index < fx.variants.length; index += 1) {
    const variant = fx.variants[index]!;
    if (variant.frames.length === 0) continue;
    if (variant.width < w || variant.height < h) continue;
    const area = variant.width * variant.height;
    if (area < bestArea) {
      best = index + 1;
      bestArea = area;
    }
  }
  return best;
}

/**
 * 字体炫彩动画的 CSS：每个变体一套 `@keyframes`，靠 `[data-fontfx="<id>-<变体>"]` 选中。
 *
 * 四个关键决定：
 *
 *  1. **画在一个专属图层上（`::before` / `::after`），不是元素本体的 `background`。**
 *     元素本体的 `background` 会被它自己的 `border-image`（气泡底图）盖住 —— 这就是
 *     「动画被气泡遮住、只在气泡圆角外露一点」的原因。伪元素带负 `z-index` 时画在
 *     「元素自身背景/边框之上、文字之下」，正是「气泡里面、气泡底图之上」那一层。
 *  2. **挑当前空着的那个伪元素。** 气泡底图占着元素本体（我方）或 `::before`（对方
 *     镜像层），动效叠加层占着 `::after`（仅我方）—— 所以：
 *       - 我方行（`.mine`）→ `::before`（`::after` 留给气泡自己的动效叠加层）
 *       - 对方行 / 转发行 → `::after`（`::before` 被镜像底图占着）
 *     两张伪元素只有两个，凑不齐时由 {@link fxClipRingCss} 的说明收尾。
 *  3. **属性值带上字体 id**（`<id>-<变体>`，而不是裸变体号）。同一个元素上可能同时
 *     有「生效字体」和「逐条消息字体」两套规则，键里不带 id 后面注入的那款会把前面
 *     那款的 `@keyframes` 抢走。
 *  4. **只放一次（`1` + `forwards`）**。它模拟的是「字体出现之初」那一下，不是循环
 *     特效；帧序列自己会淡出，末帧归零后靠 `forwards` 停在「没有图」上，而不是弹回
 *     第一帧。`steps(1)` 同其他装扮动画：让每个关键帧撑满自己的时间段，而不是按离散
 *     属性默认的「过半才切」把每帧显示时长砍半。
 *
 * 挂不挂属性由渲染侧量完气泡尺寸决定（{@link pickFontFxFariant}），所以这段 CSS 对
 * 「气泡比动画大」的消息天然是空转的。
 */
export interface FontFxSelectors {
  /** 我方行的行级选择器（不含 `[data-fontfx]` 与 `.message-content`）。 */
  mine: string;
  /** 对方行（含转发行）的行级选择器；scope=mine 时不涉及对方，省掉即可。 */
  theirs?: string;
}

export function fontFxRules(skin: FontFxSkin, sels: FontFxSelectors): string {
  const { itemId, deriveVersion, fx } = skin;
  const layers: { pseudo: '::before' | '::after'; sel: string; mirror?: boolean }[] = [
    { pseudo: '::before', sel: sels.mine },
    ...(sels.theirs ? [{ pseudo: '::after' as const, sel: sels.theirs, mirror: true }] : []),
  ];
  const rules: string[] = [
    // 帧图层是绝对定位 + 负层级，得让 `.message-content` 同时当**包含块**和**层叠
    // 上下文**：前者给 `inset: 0` 定位，后者把负层级锁在「元素自身背景/边框之上、文字
    // 之下」那一层。挂装扮气泡时两条它已经有了（见 baseBubbleRule），这里补的是
    // 「只换字体、没挂气泡」那条路径。
    ...layers.map(
      ({ sel }) =>
        `${appendToSelectors(sel, '[data-fontfx]')} ${BUBBLE_CONTENT} {\n` +
        `  position: relative;\n` +
        `  isolation: isolate;\n` +
        `}`,
    ),
  ];
  fx.variants.forEach((variant, index) => {
    if (variant.frames.length === 0) return;
    const name = `weq-fontfx-${itemId}-${index + 1}`;
    const start = firstIndex(fx, index);
    const step = 100 / variant.frames.length;
    const stops = variant.frames.map((_, i) => {
      const pct = Math.round(Math.min(i * step, 100) * 100) / 100;
      return `  ${pct}% { background-image: url("${dressFontFrameUrl(itemId, start + i + 1, deriveVersion)}"); }`;
    });
    // 末帧显式归零：帧序列本身就是渐隐的，不给一个 100% 会停在第一帧上。
    stops.push(`  100% { background-image: none; }`);
    const duration = variant.frames.length * FONT_FX_FRAME_MS;
    rules.push([`@keyframes ${name} {`, ...stops, `}`].join('\n'));

    for (const layer of layers) {
      const target = appendToSelectors(
        layer.sel,
        `[data-fontfx="${itemId}-${index + 1}"] ${BUBBLE_CONTENT}${layer.pseudo}`,
      );
      rules.push(
        target,
        `{`,
        ...fxLayerDecls(),
        `  background-image: url("${dressFontFrameUrl(itemId, start + 1, deriveVersion)}");`,
        // 原尺寸、不重复：不缩放也不拉伸（气泡比画布小就由气泡自己裁）。
        `  background-size: auto;`,
        // 对方行的整层被镜像，所以背景锚点也要反过来写，翻回来才落在气泡的左上角。
        layer.mirror ? `  background-position: right top;` : `  background-position: left top;`,
        `  background-repeat: no-repeat;`,
        layer.mirror ? `  transform: scaleX(-1);` : '',
        `  animation: ${name} ${duration}ms steps(1) 1 forwards;`,
        `}`,
        `@media (prefers-reduced-motion: reduce) {`,
        `  ${target} { animation: none; background-image: none; }`,
        `}`,
      );
    }
  });
  return rules.join('\n');
}

/**
 * 帧图层的公共声明 —— 一个绝对定位、盖满气泡盒、压到文字下面的空盒子。
 *
 * `border-radius: inherit` 是给「没挂装扮气泡」的主题自带气泡兜底的：那种气泡没有
 * 九宫格可裁（见 {@link fxClipRingCss}），只能跟着元素自己的圆角走。
 */
function fxLayerDecls(): string[] {
  return [
    `  content: "";`,
    `  position: absolute;`,
    `  inset: 0;`,
    `  z-index: -1;`,
    `  pointer-events: none;`,
    `  border-radius: inherit;`,
    `  overflow: hidden;`,
  ];
}

/**
 * 炫彩帧的「裁形」：用气泡九宫格当帧图层的遮罩，把帧裁成气泡形状。
 *
 * 帧是「气泡盒大小 + 原尺寸、左上角对齐」的一块贴图（实测画布就是气泡尺寸），超出
 * 气泡形状的部分（主要是九宫格的大圆角外侧）本来会画到气泡外面去。这里用
 * `-webkit-mask-box-image-*`（=`mask-border` 的前缀版，Chromium 实现了）把底图当成
 * 九宫格遮罩贴在帧图层上 —— slice/width 与底图完全一致，遮罩形状因此与气泡一模一样。
 *
 * 两个实测要点：
 *
 *  - **`slice` 必须带 `fill`**。不带 `fill` 时中间那块（气泡本体）不在遮罩里，帧就
 *    只剩边缘一圈可见（实测可见像素 9441 → 4399）；带上 `fill` 才是「完整裁形 +
 *    零溢出」（可见 9441 与不遮罩持平，溢出 2346 → 56 像素）。
 *  - **`-webkit-mask-box-image-width` 不能省**。默认宽度取 slice 的**源图像素值**，
 *    而气泡底图是按 `BUBBLE_SCALE` 缩小画的；不给宽度，遮罩棱角会和气泡对不上。
 *
 * 只在该行真的挂了炫彩帧时才注入（调用方在选择器里带上 `[data-fontfx]`）。对方行的
 * 帧图层整体被 `scaleX(-1)` 镜像（见 {@link fontFxRules}），遮罩也跟着翻 —— 而对方
 * 显示的气泡本来就是镜像底图，两者天然对齐。
 */
export function fxClipMaskCss(
  sel: string,
  opts: { imageUrl: string; slice: string; width: string },
): string {
  return [
    `${sel} {`,
    `  -webkit-mask-box-image-source: url("${opts.imageUrl}");`,
    `  -webkit-mask-box-image-slice: ${opts.slice};`,
    `  -webkit-mask-box-image-width: ${opts.width};`,
    `}`,
  ].join('\n');
}

/** 第 `index` 个变体在全局帧序里的起始下标（帧 url 从 1 开始，所以外面要 +1）。 */
function firstIndex(fx: FontFx, index: number): number {
  let n = 0;
  for (let i = 0; i < index; i += 1) n += fx.variants[i]?.frames.length ?? 0;
  return n;
}

/** 气泡是否「限制」了文字颜色。 */
export function bubbleRestrictsTextColor(textColor: string): boolean {
  // service 侧解析（bubble_skin.ts 的 buildLocalBubbleSkin）：只有 config.json 给了权威
  // 文字色才是具体色值；回退主题正文色时是 var()，不算限制。
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
  /** 静态底图 url(恒为本地九宫格 PNG,见 {@link bubbleImageUrl})。 */
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
 *
 * 这里只贴**静态底图**(元素本体的 border-image);动效帧是叠在它上面的第二层,
 * 见 {@link ninePatchLayer} / {@link frameOverlayUrl}。
 */
function baseBubbleRule(skin: BubbleSkinCss, m: BubbleMetrics, sel: string): string {
  return [
    `${sel} {`,
    `  position: relative;`,
    // 动效层靠负层级压到文字下面,而负层级只在**层叠上下文内部**才是「压到本元素背景之上」;
    // 不隔离的话它会逃到最近的祖先上下文里,反而跑到静态贴图底下(甚至被行背景整个盖掉)。
    // 用 isolation 而不是 z-index:0 —— 后者会连带改掉这个气泡相对同级元素的层级。
    `  isolation: isolate;`,
    `  background: transparent;`,
    // 文字色优先级的第 2 级(见文件头):字体自己上过色的字形走 `COLR`,CSS 的
    // `color` 根本改不动它。(dressfont 的调色板项都是真实颜色,没有用「前景色」
    // 那个特殊调色板项。)绝不要改成 `-webkit-text-fill-color` 或加 `!important`。
    `  color: ${skin.textColor};`,
    `  border-style: solid;`,
    `  border-width: 0;`,
    `  border-image-source: url("${m.imageUrl}");`,
    `  border-image-slice: ${m.slice};`,
    `  border-image-width: ${m.width};`,
    `  border-image-repeat: stretch;`,
    `  border-radius: 0;`,
    // 纵向 padding:让文字对齐拉伸源。top < bottom 时拉伸源偏上,减少上 padding;
    // top > bottom 时拉伸源偏下,增加上 padding。公式源自九宫格恒等式(bubble_skin.ts 模块头)。
    `  padding: ${m.topPad} ${m.rightPad} ${m.bottomPad};`,
    `  min-width: ${m.minWidth};`,
    `  min-height: ${m.minHeight};`,
    `}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 动效叠加层的第 1 帧 url —— 动画起来之前(以及 `prefers-reduced-motion` 定格)的
 * 静态兜底,keyframes 一旦接管就会逐帧重写 `border-image-source`。
 */
function frameOverlayUrl(itemId: number): string {
  return dressBubbleFrameUrl(itemId, 1);
}

/**
 * 一层九宫格贴图(静态底图 / 动效叠加层共用;两层几何完全一致,只是层级与贴图不同)。
 *
 * 静态底图直接写在元素本体的 border-image 上,这层只给伪元素用。层级用**负的**
 * `z-index`:元素本身开了 `isolation: isolate`,负层级子节点画在「元素自身背景/边框
 * 之上、文字之下」,正好是底图与文字之间的那一层(见文件头第 2 点)。
 *
 * 同一元素上的两层(`::before` 底图 + `::after` 动效)靠 z-index 排序,
 * 不依赖伪元素的树序。
 */
function ninePatchLayer(
  m: BubbleMetrics,
  sel: string,
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
    `  border-image-slice: ${m.slice};`,
    `  border-image-width: ${m.width};`,
    `  border-image-repeat: stretch;`,
    `  border-radius: 0;`,
    opts.mirror ? `  transform: scaleX(-1);` : '',
    opts.animation ? `  animation: ${opts.animation};` : '',
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

  // 炫彩帧的裁形（见 fxClipMaskCss）：帧画在伪元素上，用同几何的九宫格遮罩把超出
  // 气泡形状的部分裁掉。我方帧在 `::before`，对方的帧在 `::after`（遮罩跟着那层镜像）。
  rules.push(
    fxClipMaskCss(`${FX_MINE_LINE} ${BUBBLE_CONTENT}::before`, {
      imageUrl: m.imageUrl,
      slice: m.slice,
      width: m.width,
    }),
  );
  // 对方的帧与气泡动效叠加层**共用** `::after`：叠加层是贴在气泡外面的装饰，遮罩
  // 会连它一起裁掉（而 `data-fontfx` 是一直挂在行上的，裁掉就不是一闪而过），所以
  // 只有这个气泡自己没有动效时才给对方的帧加遮罩 —— 那种组合下帧会在九宫格圆角外
  // 露出一小条，代价比永久削掉气泡装饰小。
  if (theirsSel && !m.frameAnim) {
    rules.push(
      fxClipMaskCss(`${FX_THEIRS_LINE} ${BUBBLE_CONTENT}::after`, {
        imageUrl: m.imageUrl,
        slice: m.slice,
        width: m.width,
      }),
    );
  }

  // 动效叠加层:同一套九宫格、贴在静态底图之上。帧图(`bubbleframe/*.9.png`)中间是
  // 镂空的,只有上下两端的动效装饰,所以它只能「叠」不能「替」(见文件头第 2 点)。
  if (m.frameAnim) {
    rules.push(
      ninePatchLayer(m, `${sel}::after`, {
        imageUrl: frameOverlayUrl(skin.itemId),
        zIndex: -1,
        animation: m.frameAnim.animation,
      }),
    );
  }

  // 对方消息镜像:同一张素材直接放左侧,尖角/装饰会朝外,看起来「反的」。QQ 自己
  // 就是把素材左右镜像后贴到对方消息上的。不能对整个 .message-content 做
  // scaleX(-1) —— 文字会跟着镜像;所以两层贴图都挪到伪元素上翻转,文字留在元素
  // 自身不动:底图 `::before`(z-index -2)、动效层 `::after`(z-index -1)。
  if (theirsSel) {
    rules.push(
      `${theirsSel} {`,
      `  border-image-source: none;`,
      `}`,
      ninePatchLayer(m, `${theirsSel}::before`, {
        imageUrl: m.imageUrl,
        zIndex: -2,
        mirror: true,
      }),
      m.frameAnim
        ? ninePatchLayer(m, `${theirsSel}::after`, {
            imageUrl: frameOverlayUrl(skin.itemId),
            zIndex: -1,
            mirror: true,
            animation: m.frameAnim.animation,
          })
        : '',
    );
  }

  // 减少动态效果偏好:定格在第一帧,不循环切换。
  if (m.frameAnim) {
    rules.push(
      `@media (prefers-reduced-motion: reduce) {`,
      `  ${sel}::after { animation: none; }`,
      theirsSel ? `  ${theirsSel}::after { animation: none; }` : '',
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

  // 文字色受限的气泡：链接 / @提及不再标蓝（会和气泡文字色冲突），改为继承气泡色 + 下划线。
  if (bubbleRestrictsTextColor(skin.textColor)) {
    rules.push(bubbleLinkMentionRules(sel));
  }

  return rules.filter(Boolean).join('\n');
}

/**
 * 独立气泡预览的九宫格 CSS —— 给非聊天容器用(目前是「已装」列表里没有商城预览图的
 * 那批气泡,如旧版 40801 自动装遗留的款,素材是本地九宫格 PNG)。
 *
 * 与 bubbleRules 共用 bubbleMetrics / baseBubbleRule / ninePatchLayer,几何完全一致;
 * 静态预览 = 底图 + 动效第 1 帧(定格,不带循环动效),与聊天里的首帧观感相同。
 * sel 是调用方自己的容器选择器,样式注入由调用方负责。
 */
export function bubblePreviewCss(skin: BubbleSkinCss, sel: string): string {
  const m = bubbleMetrics(skin);
  return [
    baseBubbleRule(skin, m, sel),
    // 预览容器不会做左右镜像(它显示的是「自己」的那一版),所以叠加层同样不翻。
    m.frameAnim
      ? ninePatchLayer(m, `${sel}::after`, {
          imageUrl: frameOverlayUrl(skin.itemId),
          zIndex: -1,
        })
      : '',
  ]
    .filter(Boolean)
    .join('\n');
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

export function fontRules(font: FontSkinCss, scope: DressScope): string {
  // @font-face 不在这里声明 —— 字体经 FontFace API 预加载后注册进 document.fonts
  // (见 preloadFont)。那样字形在样式落地前就绪,不会触发 swap 的二次重排。
  const fxSkin = toFontFxSkin(font);
  return [
    // fallback 必须留着 —— QQ 的装扮字体多是子集化的,缺字要能回退到正文字体。
    // 这里**不能**用 `inherit`:CSS 不允许 inherit 出现在逗号列表里,整条声明会被
    // 浏览器整体丢弃(字体因此永远不生效,且控制台不报错)。要写成真实的字体族名。
    `${bubbleSelector(scope)} {`,
    `  font-family: "${fontFamilyFor(font.itemId)}", var(--im-font-body, Inter), ui-sans-serif, system-ui, sans-serif;`,
    `}`,
    // 炫彩帧:属性挂在**行**上(渲染侧量完气泡尺寸才挂)。帧图层按我方/对方挑不同的
    // 伪元素(见 fontFxRules),所以这里要分开传两套行选择器 —— scope=mine 时对方
    // 行根本没换上这款字,不用给。
    fxSkin
      ? fontFxRules(fxSkin, {
          mine: '.message-line.mine',
          ...(scope === 'all' ? { theirs: '.message-line.theirs' } : {}),
        })
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 「谁 + 产出它的版本 + 帧几何」—— 两个渲染路径（生效字体 / 逐条消息字体）都把它
 * 翻成同一形状，帧 url、`data-fontfx`、`@keyframes` 名才能对齐。
 *
 * 入参只要 `itemId/deriveVersion/fx` 三个字段：service 的 InstalledFont 与
 * FontDerived 都是这个形状。没有 `eimg`（或解出来是空表）返回 null，调用方不必自己判。
 */
export function toFontFxSkin(
  font: {
    itemId: number;
    deriveVersion: number;
    fx: FontFx | null;
  } | null,
): FontFxSkin | null {
  if (!font?.fx || font.fx.variants.length === 0) return null;
  return { itemId: font.itemId, deriveVersion: font.deriveVersion, fx: font.fx };
}

/** `@font-face` 的 family 名 —— 与 service 侧 dress_shared_cache.fontFamilyFor 的约定必须一致。 */
function fontFamilyFor(itemId: number): string {
  return `weq-dress-${itemId}`;
}

/**
 * 气泡静态底图的 url —— 恒为本地九宫格 PNG(`aio_user_bg_nor.9.png` 那张),与有没有
 * 动效无关。动效帧是叠在它上面的一层,不替换它(见 {@link frameOverlayUrl})。
 */
function bubbleImageUrl(skin: BubbleSkinCss): string {
  return dressBubbleUrl(skin.itemId);
}

/** 气泡动效叠加层的全部帧 url(逐帧预加载用)。 */
function bubbleFrameUrls(skin: BubbleSkinCss | null): string[] {
  if (!skin?.animationFrameCount) return [];
  return Array.from({ length: skin.animationFrameCount }, (_, i) =>
    dressBubbleFrameUrl(skin.itemId, i + 1),
  );
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

/**
 * 已注册的 face 对应哪款字体的哪个产物版本 —— 判「要不要重注册」的键。
 *
 * 只看 family 不够:升级后产物是**就地重写同一个文件**,family 名没变,而旧 face
 * 会一直赖在 `document.fonts` 里到下次启动 —— 表现就是「升级完字体没变化」。
 */
let registeredFaceKey: string | null = null;

function faceKey(font: { itemId: number; deriveVersion: number }): string {
  return `${font.itemId}:${font.deriveVersion}`;
}

/** 撤掉已注册的 face。取消字体时必须调,否则它会一直赖在 document.fonts 里。 */
function unregisterFont(): void {
  if (!registeredFace) return;
  document.fonts.delete(registeredFace);
  registeredFace = null;
  registeredFaceKey = null;
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
  const key = faceKey(font);
  if (registeredFace?.family === family && registeredFaceKey === key) return;

  unregisterFont();

  try {
    const face = await new FontFace(family, `url("${font.fontUrl}")`).load();
    document.fonts.add(face);
    registeredFace = face;
    registeredFaceKey = key;
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
      // 底图 + 动效叠加层的每一帧都要先解码,否则开播第一圈会逐帧闪光。
      // 底图与帧图都是本地 protocol 文件,基本秒达。
      bubble ? preloadImage(bubbleImageUrl(bubble)) : null,
      ...bubbleFrameUrls(bubble).map((url) => preloadImage(url)),
      font ? preloadFont(font) : null,
      // 炫彩帧同样要预先解码(帧多、播放短,第一圈逐帧解码就是可见的闪)。
      ...fontFxFrameUrls(toFontFxSkin(font)).map((url) => preloadImage(url)),
      // 挂件帧是本地 protocol 文件,首帧以后基本秒达;但首帧没解码就开播仍然会闪,
      // 所以逐帧预加载完再注入(与 msgDecorationStyle 的 preloadImages 同思路)。
      ...widgetFrameUrls(widget).map((url) => preloadImage(url)),
    ].filter(Boolean),
  );

  applyDressSkin(bubble, font, widget, scope);
}
