/**
 * 气泡装扮的本地九宫格解析（local-only）。
 *
 * 所有气泡资源一律以 Android `.9.png`（npTc 私有 chunk 存切片几何）为最终产物，
 * 由共享缓存的**唯一一条下载链**（本地离线 bundle zip → 在线 protocol zip）解出来
 * 落盘后，这里负责从磁盘 png 算出渲染参数：
 *
 *  - slice：九宫格拉伸点（npTc 的 zoomPoint）与整图尺寸的组合
 *    slice = { left: zx-1, top: zy-1, right: W-zx-1, bottom: H-zy-1 }
 *    恒等式 left + 2 + right === W，top + 2 + bottom === H —— 校验通过后再按
 *    {@link MIDDLE_GROW_PX} 把中央拉伸源单边加宽几像素（此时恒等式不再成立；
 *    渲染侧的 width 跟着变小，四条边条/四角仍是 0.5 倍自然缩放）
 *  - 文字色：优先 config.json 的权威 color（`0xAARRGGBB`）；没有就用主题正文色
 *    （本地 png 没有 CDN 那套 2×2 填充图可判明暗，从简交给主题色）。
 *
 * 历史上这里还维护过一条「CDN immersive 整图（static-all.png）」的解析链 —— 商城
 * material 直链 / 老式 itemId 拼路径探测 / 左上角切片量 zoom / 2×2 填充判色 /
 * APNG 动效层探测 —— 已整体移除：外链推不出来（新款目录段是服务端 nonce），
 * 而 zip 九宫格路径（bundle / protocol 共用）零依赖就够。渲染与导出只认
 * 本地九宫格 + bubbleframe 帧动画两种形态。
 */

import { readFileSync } from 'node:fs';
import { getLogger, logErrorContext } from '../common/logger';
import { pngSize } from '../common/zip';

/** border-image 的四边切片(单位:源图像素)。 */
export interface BubbleSlice {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 中央拉伸源单边「多吃」的源图像素上限（见 {@link buildLocalBubbleSkin}）。
 *
 * npTc 给的拉伸源只有 **2px**（恒等式 `left + 2 + right === W`）。这 2px 要铺满整个
 * 气泡中段：一个字的消息里就是横拉 8~9 倍。浏览器对 border-image 的拉伸是**插值**的
 * ——2px 被抹成一条平滑的竖条，而左右两角是 0.5 倍缩放、纹理是清晰的 2×2 颗粒。两者
 * 在 x = 左切片 / 右切片 处交界：交界两侧的「颗粒」对不上，看上去就是**两条竖缝**
 * （气泡越窄、拉伸倍率越大，缝越显眼；多行/宽气泡里它就是气泡的「身子」，反而不容易
 * 注意到）。
 *
 * 把拉伸源单边多吃几个像素即可把倍率压下来（2px → 8px 就降 4 倍）。渲染侧的
 * `border-image-width` 是按 `slice * scale` 算的，所以切片变窄时四条边条/四角**仍是
 * 0.5 倍自然缩放**（贴图本身一个像素都不变，只是边条少画最后那几列/行），只有中段的
 * 拉伸倍率下降。
 *
 * 不能吃太多：拉伸源两端的像素是**按边条原尺寸画**的装饰，卷进中段就会被拉伸。
 * {@link buildLocalBubbleSkin} 里另外按切片大小做了上限（每次最多吃 1/8）。
 */
const MIDDLE_GROW_PX = 3;

/** 一款气泡渲染所需的全部参数。 */
export interface BubbleSkin {
  itemId: number;
  /**
   * 商城里的款名(如「橘子汽水」)。装的时候由调用方从商城条目带进来 —— 商城只有
   * 排行榜和搜索两个查询、没有「按 itemId 查详情」，装的那一刻不记下来就补不回来。
   * 渲染这款气泡本身用不到它，存下来纯粹为了「我的装扮」列表能显示人话。
   */
  name?: string;
  /** 商城的预览图外链。同 {@link name}，给「我的装扮」列表复用商城卡片。 */
  previewUrl?: string;
  /** border-image-slice 的四个值。 */
  slice: BubbleSlice;
  /** 源图尺寸,渲染侧据此按 scale 换算 border-image-width。 */
  imageSize: { w: number; h: number };
  /** 气泡内文字色(CSS 颜色串)。来源见 {@link buildLocalBubbleSkin}。 */
  textColor: string;
  /**
   * 本地九宫格 PNG 的绝对路径。local-only 模型下恒有值 —— 渲染一律走
   * `weq-media://dressbubble?id=`（主进程按 itemId 从共享缓存取文件），不再有
   * CDN 直链分支。
   */
  localFile: string;
  /**
   * 整泡帧动画的帧数(0/undefined = 没有)。每帧是独立的九宫格 PNG
   * (`bubbleframe/0001.9.png`…)，渲染侧生成 CSS `@keyframes` 逐帧切换
   * `border-image-source`(见 msgDecorationStyle.ts / dressSkin.ts)。
   */
  animationFrameCount?: number;
  /** 每帧停留时长(ms)。仅 {@link animationFrameCount} 有值时有意义。 */
  animationFrameTimeMs?: number;
  /** 循环次数,0 视为无限循环。仅 {@link animationFrameCount} 有值时有意义。 */
  animationRepeat?: number;
}

/** {@link buildLocalBubbleSkin} 的入参 —— 全部来自共享缓存的 zip 下载链。 */
export interface LocalBubbleInput {
  itemId: number;
  /** 已落盘的 .9.png 绝对路径。 */
  pngPath: string;
  /** 权威文字色(`0xAARRGGBB`)，来自 zip 侧 config.json。没给则主题正文色。 */
  color?: string;
  /** 整泡帧动画(由 config.json 的 animation_sets + other.zip 解出的帧数)。 */
  animation?: { frameCount: number; frameTimeMs: number; repeat: number };
}

/**
 * 从本地 .9.png + npTc 几何构建一款气泡的完整渲染参数。
 *
 * 纯本地文件操作,零网络零探测。九宫格不合法(无 npTc / 恒等式不成立)返回 null ——
 * 宁可不渲染,也别渲染出一个切错的气泡。
 */
export function buildLocalBubbleSkin(input: LocalBubbleInput): BubbleSkin | null {
  const logger = getLogger().child({ scope: 'bubble-skin' });
  try {
    const png = readFileSync(input.pngPath);
    const size = pngSize(png);
    const zoom = readNinePatchZoom(png);
    if (!size) {
      logger.warn('bubble skin: not a png', {
        event: 'bubble-skin-bad-png',
        itemId: input.itemId,
      });
      return null;
    }
    if (!zoom) {
      logger.warn('bubble skin: nine-patch without npTc zoom point', {
        event: 'bubble-skin-no-nptc',
        itemId: input.itemId,
      });
      return null;
    }

    const slice: BubbleSlice = {
      left: zoom.x - 1,
      top: zoom.y - 1,
      right: size.w - zoom.x - 1,
      bottom: size.h - zoom.y - 1,
    };

    // 恒等式校验 —— 中间恰好留 2px 拉伸源。不成立说明切片与整图对不上,放弃这款。
    if (
      slice.left + 2 + slice.right !== size.w ||
      slice.top + 2 + slice.bottom !== size.h ||
      slice.left < 1 ||
      slice.top < 1 ||
      slice.right < 1 ||
      slice.bottom < 1
    ) {
      logger.warn('bubble skin: slice identity failed', {
        event: 'bubble-skin-bad-slice',
        itemId: input.itemId,
        size,
        zoom,
      });
      return null;
    }

    // 中央拉伸源加宽（理由见 MIDDLE_GROW_PX）。单边最多吃 1/8 切片：边条的最后几列/
    // 行是「按原尺寸画」的装饰，卷进中段就会被拉伸变形。
    const grow = Math.min(
      MIDDLE_GROW_PX,
      Math.max(0, Math.floor(Math.min(slice.left, slice.top, slice.right, slice.bottom) / 8)),
    );
    const stretched: BubbleSlice = {
      left: slice.left - grow,
      top: slice.top - grow,
      right: slice.right - grow,
      bottom: slice.bottom - grow,
    };

    // 文字色:config.json 的权威色优先;没有就从简交给主题正文色(理由见模块头)。
    const textColor = input.color ? argbToCss(input.color) : 'var(--weq-fg-primary, #111111)';

    return {
      itemId: input.itemId,
      slice: stretched,
      imageSize: size,
      textColor,
      localFile: input.pngPath,
      ...(input.animation?.frameCount
        ? {
            animationFrameCount: input.animation.frameCount,
            animationFrameTimeMs: input.animation.frameTimeMs,
            animationRepeat: input.animation.repeat,
          }
        : {}),
    };
  } catch (e) {
    logger.warn('bubble skin resolve failed', {
      event: 'bubble-skin-resolve-failed',
      itemId: input.itemId,
      ...logErrorContext(e),
    });
    return null;
  }
}

/** 读 Android .9.png 的 npTc chunk,取九宫格拉伸点。 */
function readNinePatchZoom(png: Buffer): { x: number; y: number } | null {
  let i = 8;
  while (i + 8 <= png.length) {
    const len = png.readUInt32BE(i);
    const type = png.toString('latin1', i + 4, i + 8);
    if (type === 'npTc') {
      const b = png.subarray(i + 8, i + 8 + len);
      const numXDivs = b.readUInt8(1);
      const numYDivs = b.readUInt8(2);
      if (numXDivs < 1 || numYDivs < 1) return null;
      const divs = 32;
      if (b.length < divs + 4 * (numXDivs + 1)) return null;
      const x = b.readInt32BE(divs);
      const y = b.readInt32BE(divs + 4 * numXDivs);
      return x > 0 && y > 0 ? { x: x + 1, y: y + 1 } : null;
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return null;
}

/** QQ 的 `0xAARRGGBB` 色串 → CSS。解析不了时回退主题正文色。 */
function argbToCss(argb: string): string {
  const m = argb.trim().match(/^0x([0-9a-f]{8})$/i);
  if (!m) return 'var(--weq-fg-primary, #111111)';
  const n = Number.parseInt(m[1]!, 16);
  const a = (n >>> 24) & 0xff;
  const r = (n >>> 16) & 0xff;
  const g = (n >>> 8) & 0xff;
  const b = n & 0xff;
  return a === 0xff ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${(a / 255).toFixed(3)})`;
}
