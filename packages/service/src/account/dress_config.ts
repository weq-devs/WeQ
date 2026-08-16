/**
 * 装扮配置管理 — 账号级配置（哪些已装、当前用哪款）。
 *
 * 职责：
 *  - 读写 `config/accounts/{configId}/dress.json`。
 *  - 维护已装气泡/字体列表（itemId 数组）。
 *  - 维护当前激活的装扮选择（activeBubble/activeFont）。
 *  - 管理背景图片（自定义背景存在同目录下）。
 *
 * 与 {@link DressSharedCache} 分工：
 *  - 本类：管理账号的**装扮选择**（哪些已装、当前用哪款）。
 *  - Cache 类：管理全局共享的**资源文件**（PNG/TTF/ZIP）。
 */

import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { writeFileAtomicSync } from './atomic_write';

/** 装扮作用范围。 */
export type DressScope = 'mine' | 'all';

/** 背景来源。 */
export type DressBackgroundSource = 'none' | 'qq' | 'custom';

/** 气泡商城元数据（名称、预览图）。 */
export interface BubbleMeta {
  name?: string;
  previewUrl?: string;
}

/** 字体商城元数据（名称、预览图）。 */
export interface FontMeta {
  name?: string;
  previewUrl?: string;
}

/** 装扮配置（账号级）。 */
export interface DressConfig {
  /** 已装气泡 itemId 列表。 */
  installedBubbles: number[];
  /** 已装字体 itemId 列表。 */
  installedFonts: number[];
  /** 气泡商城元数据（商品名、预览图）。 */
  bubbleMeta: Record<string, BubbleMeta>;
  /** 字体商城元数据（商品名、预览图）。 */
  fontMeta: Record<string, FontMeta>;
  /** 当前激活的气泡 itemId（0 = 不用）。 */
  activeBubble: number;
  /** 当前激活的字体 itemId（0 = 不用）。 */
  activeFont: number;
  /** 作用范围（mine = 只我发的消息，all = 全部消息）。 */
  scope: DressScope;
  /** 背景来源（none = 无背景，qq = QQ 同款，custom = 自定义）。 */
  background: DressBackgroundSource;
  /** 自定义背景文件名（不含路径，文件存在同目录下）。 */
  backgroundFile: string;
  /** 浮屏挂件 ID。 */
  widgetId: string;
  /** 背景不透明度（0-1）。 */
  backgroundOpacity: number;
}

/**
 * 装扮配置服务。
 *
 * 配置文件存储在 `config/accounts/{configId}/dress.json`。
 */
export class DressConfigService {
  private readonly configPath: string;
  private readonly configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
    this.configPath = join(configDir, 'dress.json');
    mkdirSync(configDir, { recursive: true });
  }

  /**
   * 读取配置文件。
   *
   * 不存在时返回空配置（不抛错）。
   */
  read(): DressConfig {
    if (!existsSync(this.configPath)) {
      return this.emptyConfig();
    }

    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf-8')) as Partial<DressConfig>;
      return {
        installedBubbles: Array.isArray(raw.installedBubbles) ? raw.installedBubbles : [],
        installedFonts: Array.isArray(raw.installedFonts) ? raw.installedFonts : [],
        bubbleMeta: raw.bubbleMeta && typeof raw.bubbleMeta === 'object' ? raw.bubbleMeta : {},
        fontMeta: raw.fontMeta && typeof raw.fontMeta === 'object' ? raw.fontMeta : {},
        activeBubble: Number(raw.activeBubble ?? 0),
        activeFont: Number(raw.activeFont ?? 0),
        scope: raw.scope === 'all' ? 'all' : 'mine',
        background: ['none', 'qq', 'custom'].includes(raw.background as string)
          ? (raw.background as DressBackgroundSource)
          : 'none',
        backgroundFile: typeof raw.backgroundFile === 'string' ? raw.backgroundFile : '',
        widgetId: typeof raw.widgetId === 'string' ? raw.widgetId : '',
        backgroundOpacity:
          typeof raw.backgroundOpacity === 'number' ? raw.backgroundOpacity : 1,
      };
    } catch {
      return this.emptyConfig();
    }
  }

  /**
   * 写入配置文件（原子操作）。
   */
  write(config: DressConfig): void {
    writeFileAtomicSync(this.configPath, JSON.stringify(config, null, 2));
  }

  /**
   * 标记一款气泡已装（幂等）。
   */
  markBubbleInstalled(itemId: number, meta?: BubbleMeta): void {
    const cfg = this.read();
    if (!cfg.installedBubbles.includes(itemId)) {
      cfg.installedBubbles.push(itemId);
    }
    if (meta) {
      cfg.bubbleMeta[itemId] = meta;
    }
    this.write(cfg);
  }

  /**
   * 标记一款字体已装（幂等）。
   */
  markFontInstalled(itemId: number, meta?: FontMeta): void {
    const cfg = this.read();
    if (!cfg.installedFonts.includes(itemId)) {
      cfg.installedFonts.push(itemId);
    }
    if (meta) {
      cfg.fontMeta[itemId] = meta;
    }
    this.write(cfg);
  }

  /**
   * 切换激活的装扮。
   */
  setActive(kind: 'bubble' | 'font', itemId: number): void {
    const cfg = this.read();
    if (kind === 'bubble') {
      cfg.activeBubble = itemId;
    } else {
      cfg.activeFont = itemId;
    }
    this.write(cfg);
  }

  /**
   * 切换作用范围。
   */
  setScope(scope: DressScope): void {
    const cfg = this.read();
    cfg.scope = scope;
    this.write(cfg);
  }

  /**
   * 设置自定义背景图。
   *
   * 把源文件复制到配置目录下，记录文件名（不含路径）。
   */
  setCustomBackground(sourcePath: string): void {
    const fileName = basename(sourcePath);
    const destPath = join(this.configDir, fileName);
    copyFileSync(sourcePath, destPath);

    const cfg = this.read();
    cfg.background = 'custom';
    cfg.backgroundFile = fileName;
    this.write(cfg);
  }

  /**
   * 切换背景来源。
   */
  setBackground(source: DressBackgroundSource): void {
    const cfg = this.read();
    cfg.background = source;
    this.write(cfg);
  }

  /**
   * 设置背景不透明度。
   */
  setBackgroundOpacity(opacity: number): void {
    const cfg = this.read();
    cfg.backgroundOpacity = Math.max(0, Math.min(1, opacity));
    this.write(cfg);
  }

  /**
   * 选一款浮屏挂件。
   */
  setWidget(widgetId: string): void {
    const cfg = this.read();
    cfg.widgetId = widgetId;
    this.write(cfg);
  }

  /**
   * 获取自定义背景图的完整路径。
   */
  getBackgroundFile(): string | null {
    const cfg = this.read();
    if (cfg.background !== 'custom' || !cfg.backgroundFile) return null;
    const path = join(this.configDir, cfg.backgroundFile);
    return existsSync(path) ? path : null;
  }

  private emptyConfig(): DressConfig {
    return {
      installedBubbles: [],
      installedFonts: [],
      bubbleMeta: {},
      fontMeta: {},
      activeBubble: 0,
      activeFont: 0,
      scope: 'mine',
      background: 'none',
      backgroundFile: '',
      widgetId: '',
      backgroundOpacity: 1,
    };
  }
}
