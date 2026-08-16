/**
 * 装扮共享缓存管理 — 全局资源文件（bubbles/fonts/pendants）。
 *
 * 职责：
 *  - 下载、解析、存储装扮资源到 `cache/dress_shared/`。
 *  - 读取资源元数据（气泡 slice/textColor、挂件 frameCount 等）。
 *  - 推导资源文件路径（由 itemId 计算，不依赖配置文件）。
 *
 * 与 {@link DressConfigService} 分工：
 *  - 本类：管理全局共享的**资源文件**（PNG/TTF/ZIP）。
 *  - Config 类：管理账号的**装扮选择**（哪些已装、当前用哪款）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TrpcNative } from '@weq/protocol';
import { getBubbleResources, getFontResource, getPendantResources } from '@weq/protocol';
import type { AvatarCacheService } from '../bootstrap/avatar_cache';
import type { NtHelperBinding } from '@weq/native';
import { getLogger, logErrorContext } from '../common/logger';
import {
  legacyBubbleStaticUrl,
  resolveBubbleSkin,
  type BubbleSkin,
  type BubbleSource,
} from './bubble_skin';
import type { BubbleMaterial } from './web/dress_mall';
import { downloadUrlToFile } from './media_url';
import { extractFromZip, extractAllFromZip, extractFirstTtf, isRenderableSfnt } from './dress_install';

/** 气泡元数据 sidecar。 */
export interface BubbleSidecar {
  itemId: number;
  slice: { top: number; right: number; bottom: number; left: number };
  imageSize: { w: number; h: number };
  animated: boolean;
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
    private readonly avatarCache: AvatarCacheService,
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
   * 安装一款气泡：定位权威外链 → 解析几何 → 写入共享缓存。
   *
   * 返回渲染所需的完整 {@link BubbleSkin}（含路径推导）。
   */
  async installBubble(
    itemId: number,
    material?: BubbleMaterial | null,
  ): Promise<BubbleSkin | null> {
    // 已经有 sidecar 说明安装过了，直接读取。
    const sidecarPath = join(this.bubblesDir, `${itemId}.json`);
    if (existsSync(sidecarPath)) {
      return this.loadBubbleSkin(itemId);
    }

    const src = material
      ? ({
          staticUrl: material.staticAll,
          animationUrl: material.animationAll,
          zoomPoint: { x: material.zoomPointX, y: material.zoomPointY },
          color: material.color,
        } satisfies BubbleSource)
      : await this.resolveBubbleUrl(itemId);
    if (!src) return null;

    const resolved = await resolveBubbleSkin(this.avatarCache, itemId, src);
    if (!resolved) return null;

    // 写入 sidecar（slice/textColor/animated 等元数据）。
    const sidecar: BubbleSidecar = {
      itemId,
      slice: resolved.slice,
      imageSize: resolved.imageSize,
      animated: resolved.animated,
      textColor: resolved.textColor,
      ...(resolved.animationFrameCount
        ? {
            animationFrameCount: resolved.animationFrameCount,
            animationFrameTimeMs: resolved.animationFrameTimeMs,
            animationRepeat: resolved.animationRepeat,
          }
        : {}),
    };
    writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));

    this.logger.info('installed bubble to shared cache', {
      event: 'dress-install-bubble-shared',
      itemId,
      animated: resolved.animated,
      hasFrameAnimation: Boolean(resolved.animationFrameCount),
    });

    return this.loadBubbleSkin(itemId);
  }

  /**
   * 从 sidecar 重建 {@link BubbleSkin}。
   *
   * CDN 直链气泡：staticUrl/animationUrl 照常填；本地文件气泡：推导路径。
   */
  private loadBubbleSkin(itemId: number): BubbleSkin | null {
    const sidecarPath = join(this.bubblesDir, `${itemId}.json`);
    if (!existsSync(sidecarPath)) return null;

    try {
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as BubbleSidecar;
      const localFile = join(this.bubblesDir, `${itemId}.png`);
      const hasLocalFile = existsSync(localFile);

      // CDN 直链气泡（老款 immersive 路径）没有本地文件。
      const staticUrl = hasLocalFile ? '' : legacyBubbleStaticUrl(itemId);
      const animationUrl = hasLocalFile
        ? null
        : sidecar.animated
          ? `https://tianquan.gtimg.cn/immersive/bubble/${itemId}/animation-all.png`
          : null;

      return {
        itemId,
        slice: sidecar.slice,
        imageSize: sidecar.imageSize,
        animated: sidecar.animated,
        textColor: sidecar.textColor,
        staticUrl,
        localFile: hasLocalFile ? localFile : null,
        animationUrl,
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
   * 只有 itemId 时找气泡的权威外链（protocol 兜底）。
   */
  private async resolveBubbleUrl(itemId: number): Promise<BubbleSource | null> {
    const legacy = legacyBubbleStaticUrl(itemId);
    if (await urlExists(legacy)) {
      return { staticUrl: legacy };
    }

    const pid = this.resolvePid();
    if (!pid) {
      this.logger.warn('bubble needs online instance', {
        event: 'dress-bubble-needs-online',
        itemId,
      });
      return null;
    }

    const res = await getBubbleResources(this.nt, pid, itemId);
    if (!res.staticZip?.ok) return null;

    const zipPath = join(this.bubblesDir, `${itemId}.zip`);
    const dl = await downloadUrlToFile(res.staticZip.url, zipPath);
    if (!dl.ok) return null;

    const png = extractFromZip(readFileSync(zipPath), (n) => /aio_user_bg_nor\.9\.png$/i.test(n));
    if (!png) return null;

    const zoom = readNinePatchZoom(png);
    if (!zoom) {
      this.logger.warn('nine-patch without npTc zoom point', {
        event: 'dress-bubble-no-nptc',
        itemId,
      });
      return null;
    }

    const pngPath = join(this.bubblesDir, `${itemId}.png`);
    writeFileSync(pngPath, png);

    const config = await fetchBubbleConfig(res.config?.url);
    const animation =
      config?.animation && res.otherZip?.ok
        ? await this.extractBubbleFrames(itemId, res.otherZip.url, config.animation)
        : undefined;

    return {
      staticUrl: '',
      localFile: pngPath,
      zoomPoint: zoom,
      animationUrl: '',
      color: config?.color,
      animation,
    };
  }

  /**
   * 下 other.zip，把帧动画解出来。
   */
  private async extractBubbleFrames(
    itemId: number,
    otherZipUrl: string,
    anim: { zipName: string; frameTimeMs: number; repeat: number },
  ): Promise<BubbleSource['animation']> {
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
   * 安装一款字体：换下载链 → 下 zip → 解出 ttf → 转换（如需要）→  写入共享缓存。
   */
  async installFont(itemId: number, _name: string): Promise<{ family: string; file: string }> {
    const file = this.fontFile(itemId);
    if (file && existsSync(file) && isRenderableSfnt(readFileSync(file))) {
      return { family: fontFamilyFor(itemId), file };
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

    const zipPath = join(this.fontsDir, `${itemId}.zip`);
    const outcome = await downloadUrlToFile(resource.url, zipPath);
    if (!outcome.ok) throw new Error(`字体下载失败: ${outcome.reason}`);

    const ttf = extractFirstTtf(readFileSync(zipPath));
    if (!ttf) throw new Error('字体包里没有找到 ttf 文件');

    const tempFile = join(this.fontsDir, `${itemId}_raw.ttf`);
    writeFileSync(tempFile, ttf);

    const finalFile = join(this.fontsDir, `${itemId}.ttf`);
    try {
      const convertResult = this.ntHelper.convertFont(tempFile, finalFile);
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

    this.logger.info('installed font to shared cache', {
      event: 'dress-install-font-shared',
      itemId,
      bytes: ttf.length,
    });

    return { family: fontFamilyFor(itemId), file: finalFile };
  }

  /**
   * 解析挂件动画帧（scupdate 兜底）。
   */
  async resolvePendantAnimation(itemId: number): Promise<PendantSidecar | null> {
    const sidecarPath = join(this.pendantsDir, `${itemId}.json`);
    const cached = readPendantSidecar(sidecarPath);
    if (cached && existsSync(join(this.pendantsDir, `${itemId}-frame-1.png`))) return cached;

    const pid = this.resolvePid();
    if (!pid) return null;

    try {
      const res = await getPendantResources(this.nt, pid, itemId);
      if (!res.otherZip?.ok) return null;

      const otherZipPath = join(this.pendantsDir, `${itemId}-other.zip`);
      const dl = await downloadUrlToFile(res.otherZip.url, otherZipPath);
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

      const frameTimeMs = (await fetchPendantInterval(res.xydata?.url)) ?? 100;
      const animation: PendantSidecar = {
        itemId,
        frameCount: frames.length,
        frameTimeMs,
        repeat: 0,
      };
      writeFileSync(sidecarPath, JSON.stringify(animation));

      this.logger.info('resolved pendant animation', {
        event: 'dress-pendant-frames',
        itemId,
        frameCount: frames.length,
        frameTimeMs,
      });
      return animation;
    } catch (e) {
      this.logger.warn('pendant animation resolve failed', {
        event: 'dress-pendant-resolve-failed',
        itemId,
        ...logErrorContext(e),
      });
      return null;
    }
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
}

/** @font-face 的 family 名。 */
export function fontFamilyFor(itemId: number): string {
  return `weq-dress-${itemId}`;
}

/** HEAD 探一个外链是否真实存在。 */
async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** 读 Android .9.png 的 npTc chunk，取九宫格拉伸点。 */
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
