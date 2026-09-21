/**
 * 装扮共享缓存管理 — 全局资源文件（bubbles/fonts/pendants）。
 *
 * 职责：
 *  - 下载、解析、存储装扮资源到 `cache/dress_shared/`。
 *  - 读取资源元数据（气泡 slice/textColor、挂件 frameCount、字体炫彩帧等）。
 *  - 推导资源文件路径（由 itemId 计算，不依赖配置文件）。
 *
 * 与 {@link DressConfigService} 分工：
 *  - 本类：管理全局共享的**资源文件**（PNG/TTF/ZIP）。
 *  - Config 类：管理账号的**装扮选择**（哪些已装、当前用哪款）。
 *
 * ## 派生版本（{@link DRESS_DERIVE_VERSION}）—— 升级后怎么让客户端重新产出资源
 *
 * 装扮资源分两层：
 *  - **原始件**：从 CDN / 离线 bundle 下来的 `fonts/<id>.zip`、`bubbles/<id>.png`。它们
 *    是「服务端给什么就是什么」，与 WeQ 的版本无关，升级后不需要重新下载。
 *  - **派生物**：`fonts/<id>.ttf`（FTF → 彩色 TTF 的转换产物）、`fonts/<id>_assets/`
 *    （eimg 炫彩帧）以及描述它们的 `fonts/<id>.json` sidecar。它们取决于**我们的转换链**
 *   怎么写 —— 转换链改了，缓存里那份就是旧的。
 *
 * 所以升级后不必清缓存、也不必重新下载：sidecar 里记着产出这份派生物的转换链版本，
 * 读到时对不上就**就地重新派生**（{@link DressSharedCache.installFont} 先走本地已缓存的
 * 原始 zip，全程离线）。触发点有两个：{@link DressService.refreshDerived} 在账号打开时
 * 把「已装」的那些补一遍，以及任何一次按需 fetch（逐条消息 40801 / 导出 / 年度报告）。
 *
 * 以后气泡或挂件的解析链也变了，照这个模式加一枚字段即可（它们的 sidecar 已经在了）。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TrpcNative } from '@weq/protocol';
import { getBubbleResources, getFontResource, getPendantResources } from '@weq/protocol';
import type { NtHelperBinding } from '@weq/native';
import { getLogger, logErrorContext } from '../common/logger';
import {
  extractAllFromZip,
  extractFirstTtf,
  extractFromZip,
  isRenderableSfnt,
  pngSize,
} from '../common/zip';
import { buildLocalBubbleSkin, type BubbleSkin } from './bubble_skin';
import { downloadUrlToFile } from './media_url';

/**
 * 派生资源的版本号 —— **转换链变了就 +1**。
 *
 * 1 = 最初的 FTF → TTF 修复；2 = 彩色表（`brsh`/`cglf` → COLRv1/CPAL）+ `eimg` 炫彩帧
 * 图包 + OTS 预检；3 = 修 `eimg` 偏移基准（20405 那类「数据区第 0 槽不是图片」的字体
 * 以前一帧都导不出来）；4 = 气泡中央拉伸源加宽（`.9.png` 的 slice 存在气泡 sidecar
 * 里，见 bubble_skin.ts 的 MIDDLE_GROW_PX —— 不 +1 的话已装气泡会一直用旧的 2px
 * 拉伸源）。缓存里版本号低于它的产物会被就地重新派生（见文件头）。
 */
export const DRESS_DERIVE_VERSION = 4;

/** 一组同尺寸的炫彩帧（同一款字体下可能有好几段，见 {@link readFontFx}）。 */
export interface FontFxVariant {
  /** 画布尺寸（像素，素材原尺寸）。 */
  width: number;
  height: number;
  /** 该段包含的帧：`eimg` 槽位号，播放顺序即数组顺序。 */
  frames: number[];
}

/** 一款字体的炫彩帧素材。 */
export interface FontFx {
  variants: FontFxVariant[];
}

/** `fonts/<id>.json` —— 字体派生物的 sidecar。 */
export interface FontSidecar {
  itemId: number;
  /** 产出这份 ttf 的转换链版本，见 {@link DRESS_DERIVE_VERSION}。 */
  deriveVersion: number;
  /** 炫彩帧分组；字体里没有 `eimg` 表（绝大多数款）时缺席。 */
  fx?: FontFx;
}

/**
 * 一款已派生的字体：路径 + 派生版本 + 炫彩帧几何（渲染侧直接可用）。
 *
 * `itemId` 在这里不只是冗余：渲染路径要把它拼进字体 / 炫彩帧的 url（帧 url 的
 * `?id=`），而 `family` 是拼出来的名字，反推 id 得有额外的解析。
 */
export interface FontDerived {
  itemId: number;
  family: string;
  file: string;
  deriveVersion: number;
  fx: FontFx | null;
}

/** 气泡元数据 sidecar。 */
export interface BubbleSidecar {
  itemId: number;
  slice: { top: number; right: number; bottom: number; left: number };
  imageSize: { w: number; h: number };
  textColor: string;
  animationFrameCount?: number;
  animationFrameTimeMs?: number;
  animationRepeat?: number;
}

/** 挂件元数据 sidecar。 */
export interface PendantSidecar {
  itemId: number;
  frameCount: number;
  frameTimeMs: number;
  repeat: number;
}

/**
 * 装扮共享缓存服务。
 *
 * 所有资源按 itemId 全局共享一份，不按账号分目录。
 */
export class DressSharedCache {
  private readonly logger;
  private readonly bubblesDir: string;
  private readonly fontsDir: string;
  private readonly pendantsDir: string;

  constructor(
    private readonly nt: TrpcNative,
    private readonly ntHelper: NtHelperBinding,
    /** 共享资源根目录（通常是 `userConfig.cacheDir('dress_shared')`）。 */
    sharedDir: string,
    /** 当前已注入的 QQ pid；0 表示没有在线实例。 */
    private readonly resolvePid: () => number,
  ) {
    this.logger = getLogger().child({ scope: 'dress-shared' });
    this.bubblesDir = join(sharedDir, 'bubbles');
    this.fontsDir = join(sharedDir, 'fonts');
    this.pendantsDir = join(sharedDir, 'pendants');
    mkdirSync(this.bubblesDir, { recursive: true });
    mkdirSync(this.fontsDir, { recursive: true });
    mkdirSync(this.pendantsDir, { recursive: true });
  }

  /**
   * 安装一款气泡 —— 唯一一条下载链：本地离线 bundle(zip) → 在线 protocol(zip)，
   * 产物永远是本地九宫格 PNG（+ 可选 bubbleframe 帧动画）。不再有 CDN static-all
   * 直链 / 商城 material 路径。
   *
   * 先读缓存（sidecar + png 都在直接返回）；png 缺失（旧版 CDN 遗留）也当未装处理，
   * 走下载链自愈重下。
   */
  async installBubble(itemId: number): Promise<BubbleSkin | null> {
    const cached = this.loadBubbleSkin(itemId);
    if (cached) return cached;

    const urls = await this.resolveBubbleZipUrls(itemId);
    if (!urls) return null;

    return this.installBubbleFromUrls(itemId, urls);
  }

  /**
   * 从 sidecar + 本地 png 重建 {@link BubbleSkin}。
   *
   * 没有本地 png 直接返回 null —— local-only 模型里不存在「CDN 兜底」；调用方会把
   * 它当未装处理走下载链重下（见 {@link installBubble}）。
   */
  private loadBubbleSkin(itemId: number): BubbleSkin | null {
    const sidecarPath = join(this.bubblesDir, `${itemId}.json`);
    const localFile = join(this.bubblesDir, `${itemId}.png`);
    if (!existsSync(sidecarPath) || !existsSync(localFile)) return null;

    try {
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as BubbleSidecar;
      if (!sidecar.slice || !sidecar.imageSize || !sidecar.textColor) return null;
      return {
        itemId,
        slice: sidecar.slice,
        imageSize: sidecar.imageSize,
        textColor: sidecar.textColor,
        localFile,
        animationFrameCount: sidecar.animationFrameCount,
        animationFrameTimeMs: sidecar.animationFrameTimeMs,
        animationRepeat: sidecar.animationRepeat,
      };
    } catch (e) {
      this.logger.warn('failed to load bubble sidecar', {
        event: 'dress-load-bubble-failed',
        itemId,
        ...logErrorContext(e),
      });
      return null;
    }
  }

  /**
   * 找气泡的 zip 下载地址（本地离线 bundle 优先，protocol 兜底）。
   *
   * 只负责「换链」，不碰磁盘；bundle 与 protocol 拿到的是同形状的三个部件。
   */
  private async resolveBubbleZipUrls(
    itemId: number,
  ): Promise<{ staticZipUrl: string; configUrl?: string; otherZipUrl?: string } | null> {
    // 本地离线 bundle 优先：不需要在线 QQ，也不触发 resolvePid 闸门。
    const staticZip = this.ntHelper.queryDressResourceUrl('bubble', String(itemId), 'static.zip');
    if (staticZip) {
      return {
        staticZipUrl: staticZip.url,
        configUrl: this.ntHelper.queryDressResourceUrl('bubble', String(itemId), 'config.json')
          ?.url,
        otherZipUrl: this.ntHelper.queryDressResourceUrl('bubble', String(itemId), 'other.zip')
          ?.url,
      };
    }

    const pid = this.resolvePid();
    if (!pid) {
      this.logger.warn('bubble needs online instance', {
        event: 'dress-bubble-needs-online',
        itemId,
      });
      return null;
    }

    try {
      const res = await getBubbleResources(this.nt, pid, itemId);
      if (!res.staticZip?.ok) return null;
      return {
        staticZipUrl: res.staticZip.url,
        configUrl: res.config?.ok ? res.config.url : undefined,
        otherZipUrl: res.otherZip?.ok ? res.otherZip.url : undefined,
      };
    } catch (e) {
      this.logger.warn('bubble resource resolve failed', {
        event: 'dress-bubble-resolve-failed',
        itemId,
        ...logErrorContext(e),
      });
      return null;
    }
  }

  /**
   * 从 zip 下载链装一款气泡：解 .9.png 九宫格 → 落盘 png → config.json 配色 /
   * 帧动画 → 写 sidecar。本地 bundle 与 protocol 共用这一条，是气泡的唯一下载路径。
   */
  private async installBubbleFromUrls(
    itemId: number,
    urls: { staticZipUrl: string; configUrl?: string; otherZipUrl?: string },
  ): Promise<BubbleSkin | null> {
    const zipPath = join(this.bubblesDir, `${itemId}.zip`);
    const dl = await downloadUrlToFile(urls.staticZipUrl, zipPath);
    if (!dl.ok) return null;

    const png = extractFromZip(readFileSync(zipPath), (n) => /aio_user_bg_nor\.9\.png$/i.test(n));
    if (!png) return null;

    const pngPath = join(this.bubblesDir, `${itemId}.png`);
    writeFileSync(pngPath, png);

    // 帧动画 / 配色都来自 zip 侧的 config.json；拿不到就当纯静态款。
    const config = await fetchBubbleConfig(urls.configUrl);
    const animation =
      config?.animation && urls.otherZipUrl
        ? await this.extractBubbleFrames(itemId, urls.otherZipUrl, config.animation)
        : undefined;

    const skin = buildLocalBubbleSkin({ itemId, pngPath, color: config?.color, animation });
    if (!skin) {
      // 九宫格不合法（缺 npTc / 恒等式不成立）——清掉刚落的 png,避免占着缓存。
      rmSync(pngPath, { force: true });
      return null;
    }

    const sidecar: BubbleSidecar = {
      itemId,
      slice: skin.slice,
      imageSize: skin.imageSize,
      textColor: skin.textColor,
      ...(skin.animationFrameCount
        ? {
            animationFrameCount: skin.animationFrameCount,
            animationFrameTimeMs: skin.animationFrameTimeMs,
            animationRepeat: skin.animationRepeat,
          }
        : {}),
    };
    writeFileSync(join(this.bubblesDir, `${itemId}.json`), JSON.stringify(sidecar, null, 2));

    this.logger.info('installed bubble to shared cache', {
      event: 'dress-install-bubble-shared',
      itemId,
      hasFrameAnimation: Boolean(skin.animationFrameCount),
    });

    return skin;
  }

  /**
   * 下 other.zip，把帧动画解出来。
   */
  private async extractBubbleFrames(
    itemId: number,
    otherZipUrl: string,
    anim: { zipName: string; frameTimeMs: number; repeat: number },
  ): Promise<{ frameCount: number; frameTimeMs: number; repeat: number } | undefined> {
    try {
      const zipPath = join(this.bubblesDir, `${itemId}-other.zip`);
      const dl = await downloadUrlToFile(otherZipUrl, zipPath);
      if (!dl.ok) return undefined;

      const prefix = anim.zipName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const frameRe = new RegExp(`^${prefix}/.*\\.9\\.png$`, 'i');
      const frames = extractAllFromZip(readFileSync(zipPath), (n) => frameRe.test(n)).sort(
        (a, b) => {
          const na = Number(a.name.match(/(\d+)/)?.[1] ?? 0);
          const nb = Number(b.name.match(/(\d+)/)?.[1] ?? 0);
          return na - nb;
        },
      );
      if (frames.length === 0) return undefined;

      frames.forEach((frame, i) => {
        writeFileSync(join(this.bubblesDir, `${itemId}-frame-${i + 1}.png`), frame.data);
      });

      this.logger.info('extracted bubble frame animation', {
        event: 'dress-bubble-frames',
        itemId,
        frameCount: frames.length,
      });
      return { frameCount: frames.length, frameTimeMs: anim.frameTimeMs, repeat: anim.repeat };
    } catch (e) {
      this.logger.warn('bubble frame animation extract failed', {
        event: 'dress-bubble-frames-failed',
        itemId,
        ...logErrorContext(e),
      });
      return undefined;
    }
  }

  /**
   * 安装一款字体（派生链入口）：缓存命中（且是当前派生版本）直接返回，否则重新派生。
   *
   * 「命中」要求 sidecar 的 deriveVersion 等于 {@link DRESS_DERIVE_VERSION} —— 升级后
   * 缓存里那份旧产物因此不算命中，会**就地重新派生**（先用本地已缓存的原始 zip，不必
   * 联网、也不依赖 `resources/dress` 离线 bundle），这是「升级完就能看到新特性」的关键。
   *
   * 旧产物另留一份当兜底：新派生链全挂了（没原始 zip、没离线 bundle、没在线实例）时
   * 继续用旧的 —— 老款字体至少还是能渲染的，不该因为一次升级变成「装不上」。
   */
  async installFont(itemId: number, _name: string): Promise<FontDerived> {
    const derived = this.loadDerivedFont(itemId);
    if (derived) return derived;

    const stale = this.loadStaleFont(itemId);
    try {
      return await this.deriveFont(itemId);
    } catch (e) {
      if (!stale) throw e;
      this.logger.warn('font re-derive failed, keeping the stale artifact', {
        event: 'dress-font-derive-failed',
        itemId,
        deriveVersion: stale.deriveVersion,
        ...logErrorContext(e),
      });
      return stale;
    }
  }

  /**
   * 派生一款字体：**已缓存的原始 zip** → 本地离线 bundle → 在线 protocol。
   *
   * 顺序里的第一档是升级自愈的关键：原始 zip 装的时候就在缓存里，所以「重新派生」是
   * 纯本地操作 —— 离线账号、没有离线 bundle 的机器也刷得出新特性。
   */
  private async deriveFont(itemId: number): Promise<FontDerived> {
    const cachedZip = join(this.fontsDir, `${itemId}.zip`);
    if (existsSync(cachedZip)) {
      try {
        return this.deriveFontFromZip(itemId, cachedZip);
      } catch (e) {
        this.logger.warn('cached font zip re-derive failed, falling back to download', {
          event: 'dress-font-rebuild-failed',
          itemId,
          ...logErrorContext(e),
        });
      }
    }

    // 本地离线 bundle 优先：不需要在线 QQ，也不触发 resolvePid 闸门。
    for (const part of ['main', 'fzfont']) {
      const local = this.ntHelper.queryDressResourceUrl('font', String(itemId), part);
      if (!local) continue;
      try {
        return await this.installFontFromZip(itemId, local.url);
      } catch (e) {
        this.logger.warn('local font bundle install failed, try next / protocol', {
          event: 'dress-font-local-miss',
          itemId,
          part,
          ...logErrorContext(e),
        });
      }
    }

    const pid = this.resolvePid();
    if (!pid) {
      throw new Error('下载字体需要登录该账号的 QQ 客户端（字体资源只能通过在线实例换取）');
    }

    const resource = await getFontResource(this.nt, pid, itemId);
    if (!resource?.ok) {
      throw new Error(
        `服务端没有返回该字体的下载地址（${resource?.reason ?? 'unknown'}）—— 可能该款已下架`,
      );
    }

    return this.installFontFromZip(itemId, resource.url);
  }

  /**
   * 从权威外链下载字体 zip 后派生（本地 bundle 与 protocol 共用）。
   */
  private async installFontFromZip(itemId: number, zipUrl: string): Promise<FontDerived> {
    const zipPath = join(this.fontsDir, `${itemId}.zip`);
    const outcome = await downloadUrlToFile(zipUrl, zipPath);
    if (!outcome.ok) throw new Error(`字体下载失败: ${outcome.reason}`);
    return this.deriveFontFromZip(itemId, zipPath);
  }

  /**
   * 用一份**已经在本地**的原始 zip 派生字体产物：转换（彩色表 / OTS）→ 扫出 eimg 炫彩
   * 帧 → 写 sidecar。下载与派生拆开，是为了让升级后的刷新完全离线（见 {@link deriveFont}）。
   */
  private deriveFontFromZip(itemId: number, zipPath: string): FontDerived {
    const ttf = extractFirstTtf(readFileSync(zipPath));
    if (!ttf) throw new Error('字体包里没有找到 ttf 文件');

    const tempFile = join(this.fontsDir, `${itemId}_raw.ttf`);
    writeFileSync(tempFile, ttf);

    const finalFile = join(this.fontsDir, `${itemId}.ttf`);
    const assetsDir = this.fontAssetsDir(itemId);
    // 上一轮导出的帧先清干净：nt_helper 只写「这一轮真的解出来的」那些槽位，
    // 不清的话换版本后旧帧会混在新帧后面被当成一段动画。
    rmSync(assetsDir, { recursive: true, force: true });
    try {
      // assetsDir 必须与 nt_helper 的默认值（<输出名>_assets）一致，显式传是为了让
      // 「帧图落在哪」在这里一眼可见（旧版 binding 忽略第三个参数，行为不变）。
      const convertResult = this.ntHelper.convertFont(tempFile, finalFile, { assetsDir });
      this.logger.info('font conversion completed', {
        event: 'dress-font-convert',
        itemId,
        rawBytes: ttf.length,
        result: convertResult,
      });
    } catch (e) {
      rmSync(tempFile, { force: true });
      throw new Error(`字体转换失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    rmSync(tempFile, { force: true });

    const finalTtf = readFileSync(finalFile);
    if (!isRenderableSfnt(finalTtf)) {
      rmSync(finalFile, { force: true });
      throw new Error(
        '该字体用了非标准的压缩/加密格式，无法直接喂给浏览器渲染 —— 大概率是内容保护款',
      );
    }

    const fx = readFontFx(assetsDir);
    const sidecar: FontSidecar = {
      itemId,
      deriveVersion: DRESS_DERIVE_VERSION,
      ...(fx ? { fx } : {}),
    };
    writeFileSync(this.fontSidecarPath(itemId), JSON.stringify(sidecar, null, 2));

    this.logger.info('installed font to shared cache', {
      event: 'dress-install-font-shared',
      itemId,
      bytes: ttf.length,
      deriveVersion: DRESS_DERIVE_VERSION,
      fxVariants: fx?.variants.length ?? 0,
    });

    return {
      itemId,
      family: fontFamilyFor(itemId),
      file: finalFile,
      deriveVersion: DRESS_DERIVE_VERSION,
      fx,
    };
  }

  /**
   * 解析挂件动画帧（本地 bundle 优先，protocol 兜底）。
   */
  async resolvePendantAnimation(itemId: number): Promise<PendantSidecar | null> {
    const sidecarPath = join(this.pendantsDir, `${itemId}.json`);
    const cached = readPendantSidecar(sidecarPath);
    if (cached && existsSync(join(this.pendantsDir, `${itemId}-frame-1.png`))) return cached;

    // 本地离线 bundle 优先：不需要在线 QQ，也不触发 resolvePid 闸门。
    try {
      const local = this.ntHelper.queryDressResourceUrl('widget', String(itemId), 'other.zip');
      if (local) {
        const xydata = this.ntHelper.queryDressResourceUrl('widget', String(itemId), 'xydata.js');
        const installed = await this.installPendantFrames(itemId, local.url, xydata?.url);
        if (installed) return installed;
        this.logger.warn('local pendant bundle install failed, fall back to protocol', {
          event: 'dress-pendant-local-miss',
          itemId,
        });
      }
    } catch (e) {
      this.logger.warn('local pendant bundle lookup failed, fall back to protocol', {
        event: 'dress-pendant-local-miss',
        itemId,
        ...logErrorContext(e),
      });
    }

    const pid = this.resolvePid();
    if (!pid) return null;

    try {
      const res = await getPendantResources(this.nt, pid, itemId);
      if (!res.otherZip?.ok) return null;

      return this.installPendantFrames(itemId, res.otherZip.url, res.xydata?.url);
    } catch (e) {
      this.logger.warn('pendant animation resolve failed', {
        event: 'dress-pendant-resolve-failed',
        itemId,
        ...logErrorContext(e),
      });
      return null;
    }
  }

  /**
   * 从权威外链下载挂件 other.zip、解帧、写缓存（本地 bundle 与 protocol 共用）。
   */
  private async installPendantFrames(
    itemId: number,
    otherZipUrl: string,
    xydataUrl?: string,
  ): Promise<PendantSidecar | null> {
    const otherZipPath = join(this.pendantsDir, `${itemId}-other.zip`);
    const dl = await downloadUrlToFile(otherZipUrl, otherZipPath);
    if (!dl.ok) return null;

    const otherZip = readFileSync(otherZipPath);
    const aioFileZip = extractFromZip(otherZip, (n) => /(^|\/)aio_file\.zip$/i.test(n));
    if (!aioFileZip) return null;

    const frames = extractAllFromZip(aioFileZip, (n) => /^\d+\.png$/i.test(n)).sort((a, b) => {
      const na = Number(a.name.match(/(\d+)/)?.[1] ?? 0);
      const nb = Number(b.name.match(/(\d+)/)?.[1] ?? 0);
      return na - nb;
    });
    if (frames.length === 0) return null;

    frames.forEach((frame, i) => {
      writeFileSync(join(this.pendantsDir, `${itemId}-frame-${i + 1}.png`), frame.data);
    });

    const frameTimeMs = (await fetchPendantInterval(xydataUrl)) ?? 100;
    const animation: PendantSidecar = {
      itemId,
      frameCount: frames.length,
      frameTimeMs,
      repeat: 0,
    };
    writeFileSync(join(this.pendantsDir, `${itemId}.json`), JSON.stringify(animation));

    this.logger.info('resolved pendant animation', {
      event: 'dress-pendant-frames',
      itemId,
      frameCount: frames.length,
      frameTimeMs,
    });
    return animation;
  }

  /** 气泡静态图路径（本地文件）。 */
  bubbleFile(itemId: number): string | null {
    const path = join(this.bubblesDir, `${itemId}.png`);
    return existsSync(path) ? path : null;
  }

  /** 气泡帧动画某一帧路径。 */
  bubbleFrameFile(itemId: number, frame: number): string | null {
    const path = join(this.bubblesDir, `${itemId}-frame-${frame}.png`);
    return existsSync(path) ? path : null;
  }

  /** 字体文件路径。 */
  fontFile(itemId: number): string | null {
    const path = join(this.fontsDir, `${itemId}.ttf`);
    return existsSync(path) ? path : null;
  }

  /** eimg 炫彩帧的落盘目录（nt_helper 的默认 assetsDir，见 {@link deriveFontFromZip}）。 */
  private fontAssetsDir(itemId: number): string {
    return join(this.fontsDir, `${itemId}_assets`);
  }

  /** 字体 sidecar 的路径。 */
  private fontSidecarPath(itemId: number): string {
    return join(this.fontsDir, `${itemId}.json`);
  }

  /**
   * 读字体 sidecar（派生版本 + 炫彩帧几何）。不验文件内容、不读 ttf 本体 ——
   * 清单每次 getState 都会问它，必须便宜。
   */
  fontSidecar(itemId: number): FontSidecar | null {
    try {
      const raw = JSON.parse(readFileSync(this.fontSidecarPath(itemId), 'utf-8')) as FontSidecar;
      if (typeof raw.deriveVersion !== 'number') return null;
      return raw;
    } catch {
      return null;
    }
  }

  /** 缓存的字体产物是不是**当前派生版本**。 */
  isFontDerived(itemId: number): boolean {
    const sidecar = this.fontSidecar(itemId);
    return Boolean(sidecar && sidecar.deriveVersion === DRESS_DERIVE_VERSION);
  }

  /**
   * 字体的渲染入口：文件路径 + 派生版本 + 炫彩帧几何。没装返回 null。
   *
   * 旧版本产物（sidecar 缺失或版本不符）照样返回 —— 它能渲染、该显示，只是
   * 内容可能不是最新的，等着被 {@link installFont} 就地重做。
   */
  fontDerived(itemId: number): FontDerived | null {
    const file = this.fontFile(itemId);
    if (!file) return null;
    const sidecar = this.fontSidecar(itemId);
    return {
      itemId,
      family: fontFamilyFor(itemId),
      file,
      deriveVersion: sidecar?.deriveVersion ?? 0,
      fx: sidecar?.fx ?? null,
    };
  }

  /**
   * 炫彩帧的某一帧（`frame` 从 1 开始，按 `fx.variants` 展开后的全局帧序）。
   * 渲染侧拼 `weq-media://dressfontfx?id=&frame=` 就是走这里。
   */
  fontFrameFile(itemId: number, frame: number): string | null {
    const fx = this.fontSidecar(itemId)?.fx;
    if (!fx || !Number.isInteger(frame) || frame < 1) return null;
    const slot = fx.variants.flatMap((v) => v.frames)[frame - 1];
    if (slot === undefined) return null;
    const path = join(this.fontAssetsDir(itemId), `frame_${String(slot).padStart(3, '0')}.png`);
    return existsSync(path) ? path : null;
  }

  /**
   * 已派生到当前版本的字体产物；sidecar 对不上、文件损坏时返回 null（= 需要重新派生）。
   */
  private loadDerivedFont(itemId: number): FontDerived | null {
    const derived = this.fontDerived(itemId);
    if (!derived || derived.deriveVersion !== DRESS_DERIVE_VERSION) return null;
    // 只有这里会整份读 ttf 做可渲染性校验（装/取的频次低），清单路径不做。
    try {
      if (!isRenderableSfnt(readFileSync(derived.file))) return null;
    } catch {
      return null;
    }
    return derived;
  }

  /** 缓存里的**旧版本**字体产物（能渲染就当兜底用）。 */
  private loadStaleFont(itemId: number): FontDerived | null {
    const derived = this.fontDerived(itemId);
    if (!derived) return null;
    try {
      if (!isRenderableSfnt(readFileSync(derived.file))) return null;
    } catch {
      return null;
    }
    return derived;
  }

  /** 挂件帧动画某一帧路径。 */
  pendantFrameFile(itemId: number, frame: number): string | null {
    const path = join(this.pendantsDir, `${itemId}-frame-${frame}.png`);
    return existsSync(path) ? path : null;
  }

  /** 读取气泡 sidecar（含完整渲染参数）。 */
  getBubbleSkin(itemId: number): BubbleSkin | null {
    return this.loadBubbleSkin(itemId);
  }

  /** 读取挂件 sidecar。 */
  getPendantSidecar(itemId: number): PendantSidecar | null {
    const path = join(this.pendantsDir, `${itemId}.json`);
    return readPendantSidecar(path);
  }

  /**
   * 取一款气泡的原始 config.json 字节（导出装扮时打包用）。
   *
   * 与安装流程共用「本地 bundle → protocol」的换链顺序：先查本地离线索引
   * （nt_helper 的 queryDressResourceUrl），没有再发 scupdate 包问在线实例。
   */
  async bubbleConfigFile(itemId: number): Promise<Buffer | null> {
    const local = this.ntHelper.queryDressResourceUrl('bubble', String(itemId), 'config.json');
    let url = local?.url ?? null;
    if (!url) {
      const pid = this.resolvePid();
      if (!pid) return null;
      try {
        const res = await getBubbleResources(this.nt, pid, itemId);
        url = res.config?.ok ? res.config.url : null;
      } catch {
        return null;
      }
    }
    if (!url) return null;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * 取一款挂件的静态底图（aio_50.png），落盘到共享缓存后返回路径。
   *
   * 只在动画帧解析失败时作兜底（msg_decoration 的「猜测拼接」对导出没有意义，
   * 这里走真实换链拿可下载的资源）。
   */
  async pendantStaticFile(itemId: number): Promise<string | null> {
    const dest = join(this.pendantsDir, `${itemId}-static.png`);
    if (existsSync(dest)) return dest;

    const local = this.ntHelper.queryDressResourceUrl('widget', String(itemId), 'aio_50.png');
    let url = local?.url ?? null;
    if (!url) {
      const pid = this.resolvePid();
      if (!pid) return null;
      try {
        const res = await getPendantResources(this.nt, pid, itemId);
        url = res.image?.ok ? res.image.url : null;
      } catch {
        return null;
      }
    }
    if (!url) return null;
    const dl = await downloadUrlToFile(url, dest);
    return dl.ok ? dest : null;
  }
}

/** @font-face 的 family 名。 */
export function fontFamilyFor(itemId: number): string {
  return `weq-dress-${itemId}`;
}

/** 导出帧的文件名 → `eimg` 槽位号（名字就是 `frame_<slot>.png`，见 nt_helper 的 dump）。 */
function frameSlot(name: string): number {
  return Number(name.match(/(\d+)/)?.[1] ?? 0);
}

/** 只读文件头 24 字节拿 PNG 宽高 —— 帧图动辄几十 KB，整张读进来只为取尺寸不划算。 */
function readPngHeadSize(path: string): { w: number; h: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(24);
    if (readSync(fd, head, 0, 24, 0) < 24) return null;
    return pngSize(head);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * 把 `<id>_assets/` 下导出的帧按尺寸分组成「变体」。
 *
 * 实测 20405 的 109 帧不是一段长动画，而是 **5 段尺寸各不相同的连续块**：
 * 350×141 ×15、350×76 ×21、350×49 ×15、350×82 ×28、350×109 ×30 —— 宽度都是 350，
 * 差的只有高度。同一款字体的 `eimg` 里存着几种画布高度的动画（客户端按文字占几行挑
 * 一段播），按尺寸连续分组正好还原这个结构：混着依次播只会是一团乱。
 *
 * 帧序按**槽位号**而不是文件名排序：非 PNG 的槽位会被 nt_helper 跳过，编号因此有洞，
 * 字符串排序在位数不同（如 999/1000）时也不对。
 */
export function readFontFx(assetsDir: string): FontFx | null {
  let names: string[];
  try {
    names = readdirSync(assetsDir).filter((n) => /^frame_\d+\.png$/.test(n));
  } catch {
    return null;
  }
  names.sort((a, b) => frameSlot(a) - frameSlot(b));

  const variants: FontFxVariant[] = [];
  for (const name of names) {
    const size = readPngHeadSize(join(assetsDir, name));
    if (!size) continue;
    const slot = frameSlot(name);
    const current = variants[variants.length - 1];
    if (current && current.width === size.w && current.height === size.h) {
      current.frames.push(slot);
    } else {
      variants.push({ width: size.w, height: size.h, frames: [slot] });
    }
  }
  return variants.length > 0 ? { variants } : null;
}

/** 下 config.json，拿顶层 color 与 animation_sets.bubbleframe_anim。 */
async function fetchBubbleConfig(
  url: string | undefined,
): Promise<
  | { color?: string; animation?: { zipName: string; frameTimeMs: number; repeat: number } }
  | undefined
> {
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      color?: unknown;
      bubbleframe_animation?: { animation_set?: unknown };
      animation_sets?: Record<
        string,
        { zip_name?: unknown; time?: unknown; repeat?: unknown; count?: unknown }
      >;
    };
    const color = typeof json.color === 'string' ? json.color : undefined;

    const setKey = json.bubbleframe_animation?.animation_set;
    const set = typeof setKey === 'string' ? json.animation_sets?.[setKey] : undefined;
    const zipName = typeof set?.zip_name === 'string' ? set.zip_name : undefined;
    const frameTimeMs = Number(set?.time ?? 0);
    const hasFrames = Number(set?.count ?? 0) > 0;
    const animation =
      zipName && hasFrames && frameTimeMs > 0
        ? { zipName, frameTimeMs, repeat: Number(set?.repeat ?? 0) }
        : undefined;

    return { color, animation };
  } catch {
    return undefined;
  }
}

/** 读挂件动画的磁盘 sidecar。 */
function readPendantSidecar(path: string): PendantSidecar | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PendantSidecar>;
    if (!raw.itemId || !raw.frameCount || !raw.frameTimeMs) return null;
    return {
      itemId: Number(raw.itemId),
      frameCount: Number(raw.frameCount),
      frameTimeMs: Number(raw.frameTimeMs),
      repeat: Number(raw.repeat ?? 0),
    };
  } catch {
    return null;
  }
}

/** 下 xydata.js，读逐帧动画的时间轴。 */
async function fetchPendantInterval(url: string | undefined): Promise<number | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const text = await res.text();
    const match = text.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
    const captured = match?.[1];
    if (!captured) return undefined;
    const json = JSON.parse(captured) as {
      data?: { faceAddonInfo?: Array<{ interval?: unknown }> };
    };
    const interval = Number(json.data?.faceAddonInfo?.[0]?.interval);
    return Number.isFinite(interval) && interval > 0 ? interval : undefined;
  } catch {
    return undefined;
  }
}
