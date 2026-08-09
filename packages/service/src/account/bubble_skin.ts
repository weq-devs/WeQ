/**
 * 气泡装扮的九宫格几何探测。
 *
 * QQ 的气泡资源在移动端是 Android `.9.png`(切片信息编在 PNG 的 npTc 私有 chunk 里),
 * 但同一份资源在 CDN 上还有一套「immersive」分发路径,把九宫格拆成了独立切片,其中
 * `static-all.png` 是整图(128×112)、`animation-all.png` 是 APNG 动效层。
 *
 * ## 外链推不出来 —— 必须由调用方给
 *
 * 曾经以为路径能按 `immersive/bubble/<itemId>/…` 拼。**老款是这样,新款不是**:
 *
 *   老: immersive/bubble/2130704/static-all.png
 *   新: immersive/bubble/20ad45c9/797bfea60982f009/static-all.png
 *
 * 第一段是 `md5(itemId)[:8]`(可推),第二段 16 位 hex 实测在 64 位空间里均匀散布、与
 * itemId 无关,也不是 md5/sha1/sha256/crc32 对 itemId / 名称 / 各字段组合的任何切片 ——
 * 应是服务端的内容摘要或版本 nonce,**推不出来**。静态排行 20 款里 12 款是新式路径,按
 * itemId 拼一律 404(这正是「哭包喵吃鱼」「小鸟游星野」等解析失败的原因,与动效无关)。
 *
 * 所以本模块**不再自己拼 url**,而是要求调用方提供权威外链,两条来源:
 *
 *  - 商城接口的 `immersiveMaterial`(排行/搜索/安装都走这条,零探测)——
 *    见 {@link ./web/dress_mall}.BubbleMaterial。
 *  - 只有 itemId 时走 protocol 的 scupdate 换取(需在线实例)—— 见 {@link ./dress_install}。
 *
 * 另外两条仍然成立的实测结论:
 *
 *  - **`static-all.png` 就是资源本体**,不是缩略预览 —— 与官方 zip 里解出的
 *    `aio_user_bg_nor.9.png` 逐像素完全一致(max channel diff 0)。
 *  - **动效层是叠加不是替换**:2078642 的动效图只有几颗淡星星,气泡本体在静态图里,
 *    只贴动效层会得到一个几乎空白的气泡。渲染侧两层都要画。APNG 自带时序,帧数不用管。
 *
 * ## slice 公式的坑
 *
 * **不能用 `width/2`。** 气泡尖角在下方,上下固定区严重不对称,实测:
 *
 *   itemId    top-left   bottom-left
 *   2078642   65×56      65×56        ← 恰好对称,巧合
 *   2130704   68×67      68×45
 *   2141396   54×69      54×43
 *   2072805   60×70      60×42
 *
 * 正确的做法是用 `immersiveMaterial.zoomPointX/Y`(等于左上角切片的尺寸),中间留 2px
 * 作拉伸源:
 *
 *   slice = { left: zx-1, top: zy-1, right: W-zx-1, bottom: H-zy-1 }
 *   恒等式 left + 2 + right === W,top + 2 + bottom === H
 *
 * 恒等式不成立就判定该款不可用 —— 宁可不渲染,也别渲染出一个切错的气泡。
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { AvatarCacheService } from '../bootstrap/avatar_cache';
import { getLogger, logErrorContext } from '../common/logger';

/** 装扮资源 CDN。与 media_protocol 的 `weq-media://dress` host 白名单一致。 */
const DRESS_CDN = 'https://tianquan.gtimg.cn';

/** border-image 的四边切片(单位:源图像素)。 */
export interface BubbleSlice {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 一款气泡渲染所需的全部参数。 */
export interface BubbleSkin {
  itemId: number;
  /**
   * 商城里的款名(如「橘子汽水」)。装的时候由调用方从商城条目带进来。
   *
   * 渲染这款气泡本身用不到它,存下来纯粹是为了「我的装扮」列表能显示人话 ——
   * 商城只有排行榜和搜索两个查询,都拿不到「按 itemId 查详情」,所以装的那一刻
   * 不记下来,之后就再也补不回来了(只剩「气泡 2130704」这种)。
   */
  name?: string;
  /**
   * 商城的预览图外链。同 {@link name},是给「我的装扮」列表复用商城那套卡片用的。
   *
   * **不能由 itemId 推出来** —— 新款的目录段是服务端 nonce(见模块头),所以
   * 同样必须在安装时落盘。缺省时列表回退到拿九宫格整图当预览(会糊)。
   */
  previewUrl?: string;
  /** border-image-slice 的四个值。 */
  slice: BubbleSlice;
  /** 源图尺寸,渲染侧据此按 scale 换算 border-image-width。 */
  imageSize: { w: number; h: number };
  /** 该款是否有 APNG 动效版本。 */
  animated: boolean;
  /** 气泡内文字色(CSS 颜色串)。来源见 {@link resolveTextColor}。 */
  textColor: string;
  /** 静态底图 url(CDN 直链)。走本地文件时为空串,看 {@link localFile}。 */
  staticUrl: string;
  /**
   * 本地九宫格 PNG 的绝对路径(protocol 兜底路径解出来的),不走本地文件时为 null。
   *
   * 渲染侧据此二选一:有 localFile 走 `weq-media://dressbubble?id=`,否则
   * `weq-media://dress?src=`(后者只放行 tianquan.gtimg.cn)。
   */
  localFile: string | null;
  /**
   * 动效叠加层 url(APNG),没有动效版本时为 null。
   *
   * **是叠加不是替换** —— 实测 2078642 的 animation-all.png 只有几颗淡星星,气泡本体
   * 在 static-all.png 里。渲染侧必须两层都画(静态在下、动效在上),只贴动效层会得到
   * 一个几乎空白的气泡。
   */
  animationUrl: string | null;
  /**
   * 整泡帧动画的帧数(0/undefined = 没有)。只有 protocol 兜底路径(localFile 场景)
   * 会给这个 —— 每帧是独立的九宫格 PNG(`bubbleframe/0001.9.png`…),不是像
   * {@link animationUrl} 那样现成的一张 APNG,渲染侧要生成 CSS `@keyframes` 逐帧
   * 切换 `border-image-source`(见 msgDecorationStyle.ts / dressSkin.ts)。
   */
  animationFrameCount?: number;
  /** 每帧停留时长(ms)。仅 {@link animationFrameCount} 有值时有意义。 */
  animationFrameTimeMs?: number;
  /** 循环次数,0 视为无限循环。仅 {@link animationFrameCount} 有值时有意义。 */
  animationRepeat?: number;
}

/**
 * 老式(itemId 直接当目录段)的静态整图外链。
 *
 * **只对老款有效**,新款是 hash 路径(见模块头)。仅用于 protocol 兜底路径的第一次尝试
 * 和向后兼容;新代码应当走 material 提供的权威外链。
 */
export function legacyBubbleStaticUrl(itemId: number | string): string {
  return `${DRESS_CDN}/immersive/bubble/${itemId}/static-all.png`;
}

/** 老式动效整图(APNG)。不存在时上游回 302。限制同 {@link legacyBubbleStaticUrl}。 */
export function legacyBubbleAnimationUrl(itemId: number | string): string {
  return `${DRESS_CDN}/immersive/bubble/${itemId}/animation-all.png`;
}

/**
 * 把同目录下的兄弟资源换成另一个文件名。
 *
 * 权威外链的目录段可能是 itemId 也可能是两段 hash,但**同一款的各切片总在同一目录**,
 * 所以从 `staticAll` 换个文件名就能拿到填充图,不必关心目录长什么样。
 */
function siblingUrl(staticAll: string, fileName: string): string {
  return staticAll.replace(/[^/]+$/, fileName);
}

/** PNG IHDR 里的宽高。非 PNG 或过短时返回 null。 */
function pngSize(data: Buffer): { w: number; h: number } | null {
  // 8 字节签名 + 4 长度 + 4 类型 'IHDR' + 4 宽 + 4 高
  if (data.length < 24) return null;
  if (data.readUInt32BE(0) !== 0x89504e47) return null;
  if (data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
}

/**
 * 解出 2×2 填充图左上角那个像素的 RGBA。
 *
 * 只支持 8-bit RGBA(colorType 6)—— 实测这些填充图一律是这个格式。IDAT 解压后每行前
 * 有一个 filter 字节,第一行的 filter 只可能是 0(None)/1(Sub)/2(Up),而这三种对**行首
 * 第一个像素**的还原都等于原值(Sub 的左邻和 Up 的上邻都不存在,按 0 处理)。所以直接
 * 读第 1 个像素即可,不必实现完整的反滤波。
 */
function pngFirstPixel(data: Buffer): { r: number; g: number; b: number; a: number } | null {
  if (data.length < 26) return null;
  const colorType = data.readUInt8(25);
  if (colorType !== 6) return null;

  // 收集全部 IDAT(小图通常只有一段,但规范允许分片)。
  const parts: Buffer[] = [];
  let i = 8;
  while (i + 8 <= data.length) {
    const len = data.readUInt32BE(i);
    const type = data.toString('latin1', i + 4, i + 8);
    if (type === 'IDAT') parts.push(data.subarray(i + 8, i + 8 + len));
    if (type === 'IEND') break;
    i += 12 + len;
  }
  if (parts.length === 0) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts));
  } catch {
    return null;
  }
  if (raw.length < 5) return null;
  const filter = raw.readUInt8(0);
  if (filter > 2) return null; // Average/Paeth 会引入左邻依赖,这里不处理
  return { r: raw[1]!, g: raw[2]!, b: raw[3]!, a: raw[4]! };
}

/**
 * 决定气泡内的文字色。
 *
 * 优先用商城接口给的 `immersiveMaterial.color`(权威值,但需要 pskey);拿不到时退回
 * 用 2×2 填充图的相对亮度判黑白字。填充图**不总是有效** —— 实测 2130704 的填充是
 * 全透明 `(0,0,0,0)`,那款气泡只有装饰性的四角、中间是透的,聊天背景会直接透上来,
 * 所以此时要用主题的正文色(**不能用 `inherit`**:chat.css 的
 * `.message-line.mine .message-content` 把 color 设成了白色,继承过来会白底白字)。
 */
function resolveTextColor(fill: { r: number; g: number; b: number; a: number } | null): string {
  // alpha 太低说明这款气泡没有纯色填充,聊天背景透上来 —— 用主题正文色。
  if (!fill || fill.a < 128) return 'var(--weq-fg-primary, #111111)';
  // WCAG 相对亮度(sRGB 线性化)。
  const chan = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * chan(fill.r) + 0.7152 * chan(fill.g) + 0.0722 * chan(fill.b);
  return lum > 0.45 ? '#111111' : '#ffffff';
}

/**
 * 探测某个动效外链是否真实存在。
 *
 * **必须 `redirect: 'manual'`**:该款没有动效时上游回 302,而 Location 指向的
 * `gxh.vip.qq.com` 实测连 TLS 都握不上。跟随重定向会把「没有动效」变成一个网络异常,
 * 既慢又难和真的网络故障区分。
 *
 * 走 material 时不需要这一步 —— `animationAll` 字段的有无就是答案。
 */
async function probeAnimated(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** {@link resolveBubbleSkin} 的入参 —— 权威外链由调用方给(理由见模块头)。 */
export interface BubbleSource {
  /** 静态底图直链。走本地文件时(protocol 兜底)传空串,由 `localFile` 顶上。 */
  staticUrl: string;
  /**
   * 本地九宫格 PNG 的绝对路径 —— protocol 兜底路径用(从 `static.zip` 解出来的)。
   *
   * 给了它就不走网络:尺寸直接读这个文件。渲染侧也必须走本地分支
   * (`weq-media://dressbubble`),因为 `weq-media://dress` 只放行 tianquan.gtimg.cn。
   */
  localFile?: string;
  /**
   * 动效叠加层直链。空串表示「该款无动效」(material 明确没给);
   * 传 undefined 表示「不确定」,此时会发一次 HEAD 去探。
   */
  animationUrl?: string;
  /** 九宫格拉伸点。给了就不必下载左上角切片去量。 */
  zoomPoint?: { x: number; y: number };
  /** 权威文字色(`0xAARRGGBB`)。没给则按填充图推断明暗。 */
  color?: string;
  /**
   * 整泡帧动画(protocol 兜底路径的 bubbleframe 序列,见 dress_install 的
   * `extractBubbleFrames`)。给了就在 {@link BubbleSkin} 上原样透出。
   */
  animation?: { frameCount: number; frameTimeMs: number; repeat: number };
}

/**
 * 解析一款气泡的渲染参数。
 *
 * 图片一律经 {@link AvatarCacheService} 落盘(与 `weq-media://dress` 同一套缓存),
 * 所以解析过的气泡后续渲染是零网络的。
 *
 * 有完整 material 时(商城路径)只需下载整图一张;缺 zoomPoint 时才回退到「下载左上角
 * 切片量尺寸」,缺 color 时才回退到「下载 2×2 填充图判明暗」。
 *
 * @returns 解析失败(资源不存在 / 恒等式不成立)时返回 null。
 */
export async function resolveBubbleSkin(
  cache: AvatarCacheService,
  itemId: number,
  src: BubbleSource,
): Promise<BubbleSkin | null> {
  const logger = getLogger().child({ scope: 'bubble-skin' });

  try {
    // 本地文件(protocol 兜底)直接读盘;否则走头像那套磁盘缓存。
    const png = src.localFile ? readFileSync(src.localFile) : (await cache.get(src.staticUrl)).data;
    const size = pngSize(png);
    if (!size) {
      logger.warn('bubble skin: not a png', {
        event: 'bubble-skin-bad-png',
        itemId,
        url: src.localFile || src.staticUrl,
      });
      return null;
    }

    // zoomPoint:material / npTc 给了直接用,否则回退到量左上角切片的尺寸(只有 CDN 路径
    // 有兄弟切片可量;本地路径拿不到 zoomPoint 就只能放弃)。
    let zoom = src.zoomPoint;
    if (!zoom) {
      if (src.localFile) {
        logger.warn('bubble skin: local png without zoom point', {
          event: 'bubble-skin-no-zoom',
          itemId,
        });
        return null;
      }
      const corner = pngSize(
        (await cache.get(siblingUrl(src.staticUrl, 'static-top-left-v2.png'))).data,
      );
      if (!corner) {
        logger.warn('bubble skin: corner slice unavailable', {
          event: 'bubble-skin-no-corner',
          itemId,
        });
        return null;
      }
      zoom = { x: corner.w, y: corner.h };
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
        itemId,
        size,
        zoom,
      });
      return null;
    }

    // animationUrl 为 undefined = 不确定,探一次;空串 = 明确没有动效。
    // 本地路径没有兄弟资源可探,一律当无动效。
    const animCandidate = src.localFile ? '' : siblingUrl(src.staticUrl, 'animation-all.png');
    const animationUrl =
      src.animationUrl === undefined
        ? animCandidate && (await probeAnimated(animCandidate))
          ? animCandidate
          : ''
        : src.animationUrl;

    // 文字色:material 给了直接用;否则按 2×2 填充图判明暗(本地路径没有填充图,
    // 但 .9.png 本体就带填充,直接取它中心那个像素也能判 —— 这里从简交给主题色)。
    const textColor = src.color
      ? argbToCss(src.color)
      : src.localFile
        ? resolveTextColor(null)
        : resolveTextColor(await readFill(cache, src.staticUrl));

    return {
      itemId,
      slice,
      imageSize: size,
      animated: Boolean(animationUrl) || Boolean(src.animation?.frameCount),
      textColor,
      staticUrl: src.staticUrl,
      localFile: src.localFile ?? null,
      animationUrl: animationUrl || null,
      animationFrameCount: src.animation?.frameCount,
      animationFrameTimeMs: src.animation?.frameTimeMs,
      animationRepeat: src.animation?.repeat,
    };
  } catch (e) {
    logger.warn('bubble skin resolve failed', {
      event: 'bubble-skin-resolve-failed',
      itemId,
      ...logErrorContext(e),
    });
    return null;
  }
}

/** 取 2×2 填充图的首像素。失败返回 null(交给主题默认色)。 */
async function readFill(
  cache: AvatarCacheService,
  staticUrl: string,
): Promise<{ r: number; g: number; b: number; a: number } | null> {
  try {
    return pngFirstPixel((await cache.get(siblingUrl(staticUrl, 'static-all-middle-v2.png'))).data);
  } catch {
    return null;
  }
}

/** QQ 的 `0xAARRGGBB` 色串 → CSS。解析不了时回退主题正文色(理由同 resolveTextColor)。 */
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
