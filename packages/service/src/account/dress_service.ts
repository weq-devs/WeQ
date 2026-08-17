/**
 * 装扮服务统一入口 — 组合配置管理和共享缓存。
 *
 * 这是 {@link DressConfigService} 和 {@link DressSharedCache} 的门面（Facade），
 * 对外提供统一的装扮操作接口，内部协调配置写入和资源下载。
 *
 * 替代旧的 {@link DressInstallService}，但接口尽量兼容以减少迁移成本。
 */

import type { BubbleSkin } from './bubble_skin';
import type { BubbleMaterial } from './web/dress_mall';
import { DressConfigService, type DressScope, type DressBackgroundSource } from './dress_config';
import { DressSharedCache, fontFamilyFor } from './dress_shared_cache';
import type { TrpcNative } from '@weq/protocol';
import type { NtHelperBinding } from '@weq/native';
import type { AvatarCacheService } from '../bootstrap/media_cache';

/** 已装的一款字体（兼容旧接口）。 */
export interface InstalledFont {
  itemId: number;
  name: string;
  previewUrl?: string;
  family: string;
  file: string;
}

/** 装扮清单（兼容旧接口）。 */
export interface DressManifest {
  bubbles: BubbleSkin[];
  fonts: InstalledFont[];
  activeBubble: number;
  activeFont: number;
  scope: DressScope;
  background: DressBackgroundSource;
  backgroundFile: string;
  widgetId: string;
  backgroundOpacity: number;
}

/**
 * 装扮服务。
 *
 * 内部分层：
 *  - {@link DressConfigService}：账号配置（哪些已装、当前用哪款）。
 *  - {@link DressSharedCache}：全局共享资源（下载、解析、存储）。
 */
export class DressService {
  constructor(
    private readonly config: DressConfigService,
    private readonly cache: DressSharedCache,
  ) {}

  /**
   * 读取装扮清单（兼容旧接口）。
   *
   * 从配置文件读取 itemId 列表，再从共享缓存加载完整 BubbleSkin。
   */
  read(): DressManifest {
    const cfg = this.config.read();

    // 气泡：从共享缓存加载完整 BubbleSkin，补充商城元数据。
    const bubbles: BubbleSkin[] = [];
    for (const itemId of cfg.installedBubbles) {
      const skin = this.cache.getBubbleSkin(itemId);
      if (skin) {
        const meta = cfg.bubbleMeta[itemId];
        bubbles.push({
          ...skin,
          name: meta?.name,
          previewUrl: meta?.previewUrl,
        });
      }
    }

    // 字体：从共享缓存推导路径。
    const fonts: InstalledFont[] = [];
    for (const itemId of cfg.installedFonts) {
      const file = this.cache.fontFile(itemId);
      if (file) {
        const meta = cfg.fontMeta[itemId];
        fonts.push({
          itemId,
          name: meta?.name ?? '',
          previewUrl: meta?.previewUrl,
          family: fontFamilyFor(itemId),
          file,
        });
      }
    }

    return {
      bubbles,
      fonts,
      activeBubble: cfg.activeBubble,
      activeFont: cfg.activeFont,
      scope: cfg.scope,
      background: cfg.background,
      backgroundFile: this.config.getBackgroundFile() ?? '',
      widgetId: cfg.widgetId,
      backgroundOpacity: cfg.backgroundOpacity,
    };
  }

  /**
   * 安装一款气泡。
   */
  async installBubble(
    itemId: number,
    material?: BubbleMaterial | null,
    meta?: { name?: string; previewUrl?: string },
  ): Promise<BubbleSkin | null> {
    // 1. 下载/解析资源到共享缓存。
    const skin = await this.cache.installBubble(itemId, material);
    if (!skin) return null;

    // 2. 标记已装 + 记录商城元数据。
    this.config.markBubbleInstalled(itemId, meta);

    // 3. 返回补充了商城元数据的完整 BubbleSkin。
    return { ...skin, name: meta?.name, previewUrl: meta?.previewUrl };
  }

  /**
   * 安装一款字体。
   */
  async installFont(itemId: number, name: string, previewUrl?: string): Promise<InstalledFont> {
    // 1. 下载/转换资源到共享缓存。
    const { family, file } = await this.cache.installFont(itemId, name);

    // 2. 标记已装 + 记录商城元数据。
    this.config.markFontInstalled(itemId, { name, previewUrl });

    return { itemId, name, previewUrl, family, file };
  }

  /**
   * 解析头像挂件动画帧。
   */
  async resolvePendantAnimation(itemId: number) {
    return this.cache.resolvePendantAnimation(itemId);
  }

  /** 切换生效的装扮。 */
  setActive(kind: 'bubble' | 'font', itemId: number): DressManifest {
    this.config.setActive(kind, itemId);
    return this.read();
  }

  /** 切换作用范围。 */
  setScope(scope: DressScope): DressManifest {
    this.config.setScope(scope);
    return this.read();
  }

  /** 设置自定义背景图。 */
  setCustomBackground(sourcePath: string): DressManifest {
    this.config.setCustomBackground(sourcePath);
    return this.read();
  }

  /** 切换背景来源。 */
  setBackground(source: DressBackgroundSource): DressManifest {
    this.config.setBackground(source);
    return this.read();
  }

  /** 设置背景不透明度。 */
  setBackgroundOpacity(opacity: number): DressManifest {
    this.config.setBackgroundOpacity(opacity);
    return this.read();
  }

  /** 选一款浮屏挂件。 */
  setWidget(widgetId: string): DressManifest {
    this.config.setWidget(widgetId);
    return this.read();
  }

  /** 自定义背景图的路径。 */
  backgroundFile(): string | null {
    return this.config.getBackgroundFile();
  }

  /** 已装字体的 ttf 路径。 */
  fontFile(itemId: number): string | null {
    return this.cache.fontFile(itemId);
  }

  /** 已装气泡的本地九宫格 PNG 路径。 */
  bubbleFile(itemId: number): string | null {
    return this.cache.bubbleFile(itemId);
  }

  /** 已装气泡整泡帧动画的某一帧。 */
  bubbleFrameFile(itemId: number, frame: number): string | null {
    return this.cache.bubbleFrameFile(itemId, frame);
  }

  /** 挂件帧动画的某一帧。 */
  pendantFrameFile(itemId: number, frame: number): string | null {
    return this.cache.pendantFrameFile(itemId, frame);
  }

  /**
   * 同步 QQ 正在用的装扮（bootstrap 时调用一次）。
   */
  async syncFromQq(own: {
    bubbleId?: number;
    bubbleName?: string;
    bubblePreviewUrl?: string;
    fontId?: number;
    fontName?: string;
    fontPreviewUrl?: string;
    chatBgUrl?: string;
  }): Promise<void> {
    const cfg = this.config.read();

    // 气泡：只在用户从没自己选过时才同步。
    if (own.bubbleId && cfg.activeBubble === 0) {
      try {
        await this.installBubble(own.bubbleId, null, {
          name: own.bubbleName,
          previewUrl: own.bubblePreviewUrl,
        });
        this.config.setActive('bubble', own.bubbleId);
      } catch {
        // 静默失败，不打断启动。
      }
    }

    // 字体：只在用户从没自己选过时才同步。
    if (own.fontId && this.config.read().activeFont === 0) {
      try {
        await this.installFont(own.fontId, own.fontName ?? '', own.fontPreviewUrl);
        this.config.setActive('font', own.fontId);
      } catch {
        // 静默失败，不打断启动。
      }
    }

    // 背景：只在用户从没自己选过时才切到「QQ 同款」。
    if (own.chatBgUrl && this.config.read().background === 'none') {
      this.config.setBackground('qq');
    }
  }

  /**
   * 补下自己在 QQ 里正在用的字体（monitor 后台补偿）。
   */
  async ensureOwnFont(itemId: number, name: string): Promise<void> {
    if (!itemId || this.fontFile(itemId)) return;
    try {
      await this.installFont(itemId, name);
    } catch {
      // 静默失败。
    }
  }
}

/**
 * 创建装扮服务（工厂函数）。
 *
 * @param nt TrpcNative 实例（发 OIDB 包）。
 * @param ntHelper NtHelperBinding 实例（字体转换）。
 * @param avatarCache 头像缓存服务（气泡解析用）。
 * @param configDir 账号配置目录（如 `config/accounts/{configId}/`）。
 * @param sharedCacheDir 全局共享缓存目录（如 `cache/dress_shared/`）。
 * @param resolvePid 获取在线 QQ pid 的函数。
 */
export function createDressService(
  nt: TrpcNative,
  ntHelper: NtHelperBinding,
  avatarCache: AvatarCacheService,
  configDir: string,
  sharedCacheDir: string,
  resolvePid: () => number,
): DressService {
  const config = new DressConfigService(configDir);
  const cache = new DressSharedCache(nt, ntHelper, avatarCache, sharedCacheDir, resolvePid);
  return new DressService(config, cache);
}
