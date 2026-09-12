/**
 * 导出装扮阶段 —— 把会话里实际用到的气泡 / 字体 / 挂件打包进导出 bundle。
 *
 * 资源来源完全复用 {@link DressService}（本地 `resources/dress/*.dat` 离线索引 →
 * nt_helper 的 `queryDressResourceUrl` → 在线 QQ 的 scupdate protocol 兜底），
 * 本模块只负责两件事：
 *
 *   1. **扫描**：翻一遍会话消息，从 DB 列 40801 收集实际用到的 bubbleId /
 *      fontId / widgetId（同时缓存 msgId → decoration，供 HTML 逐条打标）。
 *      漫游补全（roam）消息的 decoration 从缓存自带字段读取。
 *   2. **转换落盘**：逐款调用 dressInstall 装进共享缓存，再把原始资源原样写进
 *      `outDir/dress/`（不再合成 GIF，静态 / 动态 / json 全量导出）：
 *        - 字体 → `<id>.ttf`（转换后的标准 TTF）
 *        - 气泡 → `<id>/static.png`（静态底）+ 动效资源（逐帧 PNG 或 APNG 原文件）
 *          + `config.json` + 渲染参数 `skin.json`
 *        - 挂件 → `<id>/widget.png`（静态底）+ `frames/*.png`（逐帧动画）
 *          + `widget.json`（时间轴）
 *
 * 产物目录结构：
 *   dress/
 *     font/<id>.ttf
 *     bubble/<id>/{static.png, config.json, skin.json, animation.png?, frames/1..N.png}
 *     widget/<id>/{widget.png, widget.json, frames/1..N.png}
 *     manifest.json        ← HTML 导出据此生成字体/气泡/挂件 CSS
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MsgDecoration } from '@weq/codec';
import type { BubbleSkin } from '../bubble_skin';
import type { DressService } from '../dress_service';
import { getLogger, logErrorContext } from '../../common/logger';
import type { MsgService } from '../msg';
import type { RoamMessageSource } from './message_source';
import { iterateConv } from './sender_resolve';
import type { ConvKind, ExportTimeRange } from './types';

/** 用户在导出灯箱里勾选的装扮类别。 */
export interface DressExportKinds {
  bubble: boolean;
  font: boolean;
  widget: boolean;
}

/** 一次会话扫描得到的装扮使用情况。 */
export interface DressUsage {
  bubbles: Set<number>;
  fonts: Set<number>;
  widgets: Set<number>;
  /** msgId → decoration，供 HTML 逐条打标 / JSON 记录装饰字段（漫游消息查不到时缺省）。 */
  byMsg: Map<string, MsgDecoration>;
}

/** 一款气泡导出后的渲染参数（HTML 生成 border-image CSS 用）。 */
export interface DressBubbleManifest {
  itemId: number;
  slice: BubbleSkin['slice'];
  imageSize: BubbleSkin['imageSize'];
  textColor: string;
  animated: boolean;
  /** 相对 bundle 根目录的静态底图路径（HTML border-image 用它）。 */
  staticPng: string;
  /** 逐帧动画 PNG（protocol / 本地 bundle 路径），没有时为 null。 */
  frames: string[] | null;
  /** APNG 动效叠加层原文件（legacy / material 路径），没有时为 null。 */
  animation: string | null;
  /** 逐帧动画每帧停留时长（ms）。 */
  frameTimeMs?: number;
  /** 动画循环次数，0 = 无限循环。 */
  repeat?: number;
}

export interface DressFontManifest {
  itemId: number;
  family: string;
  /** 相对 bundle 根目录的路径。 */
  file: string;
}

export interface DressWidgetManifest {
  itemId: number;
  /** true = 有动画帧；false = 只有静态图。 */
  animated: boolean;
  /** HTML 预览用的单张图（静态底 aio_50.png，缺省时为首帧）。 */
  file: string;
  /** 动画帧 PNG 列表（相对 bundle 根目录），没有时为 null。 */
  frames: string[] | null;
  /** 每帧停留时长（ms）。 */
  frameTimeMs?: number;
  /** 动画循环次数，0 = 无限循环。 */
  repeat?: number;
}

/** HTML 导出据此生成装扮 CSS 的清单（由 dress 阶段写进 dress/manifest.json）。 */
export interface DressExportManifest {
  bubbles: DressBubbleManifest[];
  fonts: DressFontManifest[];
  widgets: DressWidgetManifest[];
}

export interface DressExportFailure {
  kind: 'bubble' | 'font' | 'widget';
  itemId: number;
  error: string;
}

export interface DressExportResult {
  ok: number;
  failed: number;
  failures: DressExportFailure[];
  manifest: DressExportManifest;
}

const DRESS_DIR = 'dress';

/** 装扮资源下载并发数（fetchBubble/fetchFont 都有网络/协议开销）。 */
const DRESS_CONCURRENCY = 4;

/** 并发跑 `fn`，最多 `limit` 个在途。 */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

/**
 * 扫描会话消息，收集实际用到的装扮 id。
 *
 * 优先从本地 msg 表 40801 列查装扮；对于漫游补全（roam）来的消息，
 * 本地表查不到时回退到漫游缓存自带的 decoration 字段。
 */
export async function collectDressUsage(
  msgs: MsgService,
  kind: ConvKind,
  conv: string,
  kinds: DressExportKinds,
  range?: ExportTimeRange,
  roam?: RoamMessageSource,
): Promise<DressUsage> {
  // 预建漫游消息的 decoration 映射：漫游消息不在本地 msg 表，
  // getMsgDecoration 查不到，但 GapFetchedMessage 自带 decoration 字段。
  const roamDecorations = new Map<string, MsgDecoration>();
  if (roam) {
    try {
      const roamMessages = await roam();
      for (const m of roamMessages) {
        if (m.conv !== conv) continue;
        const d = m.decoration;
        if (!d) continue;
        if (d.bubbleId > 0 || d.fontId > 0 || d.widgetId > 0) {
          roamDecorations.set(m.msgId, d as MsgDecoration);
        }
      }
    } catch {
      // 漫游源失败不阻断导出。
    }
  }

  const usage: DressUsage = {
    bubbles: new Set(),
    fonts: new Set(),
    widgets: new Set(),
    byMsg: new Map(),
  };
  for await (const m of iterateConv(msgs, kind, conv, range, roam)) {
    try {
      // 优先本地 DB（40801 列），本地查不到时回退漫游缓存。
      const msgId = m.msgId.toString();
      const dec =
        (await msgs.getMsgDecoration(BigInt(m.msgId))) ?? roamDecorations.get(msgId) ?? null;
      if (!dec) continue;
      if (kinds.bubble && dec.bubbleId > 0) usage.bubbles.add(dec.bubbleId);
      if (kinds.font && dec.fontId > 0) usage.fonts.add(dec.fontId);
      if (kinds.widget && dec.widgetId > 0) usage.widgets.add(dec.widgetId);
      usage.byMsg.set(msgId, dec);
    } catch {
      // 单条装饰列解析失败不影响整体导出。
    }
  }
  return usage;
}

/**
 * 逐款下载 / 转换 / 合成，写进 `outDir/dress/`，返回清单供 HTML 渲染。
 */
export async function exportDressAssets(
  dressInstall: DressService,
  outDir: string,
  usage: DressUsage,
  kinds: DressExportKinds,
  onProgress?: (done: number, total: number, note: string) => void,
  /** 是否在线补全本地未缓存的资源（4.3）。关闭时只导出已缓存部分。 */
  complete = true,
): Promise<DressExportResult> {
  const logger = getLogger().child({ scope: 'dress-export' });
  const root = join(outDir, DRESS_DIR);
  mkdirSync(root, { recursive: true });

  const manifest: DressExportManifest = { bubbles: [], fonts: [], widgets: [] };
  const failures: DressExportFailure[] = [];
  const total =
    (kinds.bubble ? usage.bubbles.size : 0) +
    (kinds.font ? usage.fonts.size : 0) +
    (kinds.widget ? usage.widgets.size : 0);
  let done = 0;
  const tick = (note: string): void => {
    done += 1;
    onProgress?.(done, total, note);
  };

  // 逐款下载 / 转换 / 合成。每项只写自己的目录（bubble/<id>、font/<id>.ttf、
  // widget/<id>），互不依赖，所以按固定顺序排队后用并发跑（网络等待不串行）。
  // 统一走 fetch* 资源级方法：导出扫的是消息里的装扮（DB 40801 / 漫游 decoration），
  // 资源落到共享缓存供打包即可，不该把账号标记成「已装」（那是显式安装的语义）。
  const jobs: Array<() => Promise<void>> = [];
  if (kinds.bubble) {
    for (const itemId of [...usage.bubbles].sort((a, b) => a - b)) {
      jobs.push(async () => {
        try {
          if (!complete && !dressInstall.hasLocal('bubble', itemId)) {
            failures.push({ kind: 'bubble', itemId, error: '本地未缓存（未开启补全下载）' });
            tick(`气泡 ${itemId} 未缓存`);
            return;
          }
          const skin = await dressInstall.fetchBubble(itemId);
          if (!skin) throw new Error('装扮服务未能解析该气泡');
          const entry = await exportBubble(dressInstall, root, itemId, skin);
          manifest.bubbles.push(entry);
          tick(`气泡 ${itemId}`);
        } catch (e) {
          failures.push({
            kind: 'bubble',
            itemId,
            error: e instanceof Error ? e.message : String(e),
          });
          tick(`气泡 ${itemId} 失败`);
        }
      });
    }
  }

  if (kinds.font) {
    for (const itemId of [...usage.fonts].sort((a, b) => a - b)) {
      jobs.push(async () => {
        try {
          if (!complete && !dressInstall.hasLocal('font', itemId)) {
            failures.push({ kind: 'font', itemId, error: '本地未缓存（未开启补全下载）' });
            tick(`字体 ${itemId} 未缓存`);
            return;
          }
          const font = await dressInstall.fetchFont(itemId);
          const dir = join(root, 'font');
          mkdirSync(dir, { recursive: true });
          const rel = `dress/font/${itemId}.ttf`;
          copyFileSync(font.file, join(outDir, rel));
          manifest.fonts.push({ itemId, family: font.family, file: rel });
          tick(`字体 ${itemId}`);
        } catch (e) {
          failures.push({
            kind: 'font',
            itemId,
            error: e instanceof Error ? e.message : String(e),
          });
          tick(`字体 ${itemId} 失败`);
        }
      });
    }
  }

  if (kinds.widget) {
    for (const itemId of [...usage.widgets].sort((a, b) => a - b)) {
      jobs.push(async () => {
        try {
          if (!complete && !dressInstall.hasLocal('widget', itemId)) {
            failures.push({ kind: 'widget', itemId, error: '本地未缓存（未开启补全下载）' });
            tick(`挂件 ${itemId} 未缓存`);
            return;
          }
          const entry = await exportWidget(dressInstall, root, itemId);
          manifest.widgets.push(entry);
          tick(`挂件 ${itemId}`);
        } catch (e) {
          failures.push({
            kind: 'widget',
            itemId,
            error: e instanceof Error ? e.message : String(e),
          });
          tick(`挂件 ${itemId} 失败`);
        }
      });
    }
  }
  await mapLimit(jobs, DRESS_CONCURRENCY, (job) => job());
  // 并发完成顺序不定，按 itemId 排回稳定顺序（HTML CSS 生成依赖固定顺序）。
  manifest.bubbles.sort((a, b) => a.itemId - b.itemId);
  manifest.fonts.sort((a, b) => a.itemId - b.itemId);
  manifest.widgets.sort((a, b) => a.itemId - b.itemId);

  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  logger.info('dress assets exported', {
    event: 'dress-export-done',
    bubbles: manifest.bubbles.length,
    fonts: manifest.fonts.length,
    widgets: manifest.widgets.length,
    failed: failures.length,
  });
  return { ok: total - failures.length, failed: failures.length, failures, manifest };
}

/** 一款气泡：静态底图 + 动效资源（逐帧 PNG / APNG 原文件）+ config.json + skin.json。 */
async function exportBubble(
  dressInstall: DressService,
  root: string,
  itemId: number,
  skin: BubbleSkin,
): Promise<DressBubbleManifest> {
  const dir = join(root, 'bubble', String(itemId));
  mkdirSync(dir, { recursive: true });

  // 1. 静态底图：local-only 模型下恒为本地九宫格 PNG，直接拷。
  writeFileSync(join(dir, 'static.png'), readFileSync(skin.localFile));

  // 2. config.json（动画定义 / 配色 / 九宫格参数）—— 用户明确要求打包。
  try {
    const cfg = await dressInstall.bubbleConfig(itemId);
    if (cfg) writeFileSync(join(dir, 'config.json'), cfg);
  } catch (e) {
    getLogger()
      .child({ scope: 'dress-export' })
      .warn('bubble config unavailable', {
        event: 'dress-export-config-miss',
        itemId,
        ...logErrorContext(e),
      });
  }

  // 3. 动效资源原样导出，不再合成 GIF：唯一形态是逐帧九宫格 PNG（bubbleframe）。
  let frames: string[] | null = null;
  const animation: string | null = null;
  let animated = false;

  if (skin.animationFrameCount && skin.animationFrameTimeMs) {
    const frameFiles: string[] = [];
    const framesDir = join(dir, 'frames');
    mkdirSync(framesDir, { recursive: true });
    for (let i = 1; i <= skin.animationFrameCount; i++) {
      const file = dressInstall.bubbleFrameFile(itemId, i);
      if (!file) break;
      copyFileSync(file, join(framesDir, `${i}.png`));
      frameFiles.push(`dress/bubble/${itemId}/frames/${i}.png`);
    }
    if (frameFiles.length === skin.animationFrameCount) {
      frames = frameFiles;
      animated = true;
    }
  }

  // 4. 渲染参数 sidecar（HTML 侧生成 border-image CSS 用）。
  writeFileSync(
    join(dir, 'skin.json'),
    JSON.stringify(
      {
        itemId,
        slice: skin.slice,
        imageSize: skin.imageSize,
        textColor: skin.textColor,
        animated,
        ...(frames
          ? {
              frames,
              frameTimeMs: skin.animationFrameTimeMs,
              repeat: skin.animationRepeat ?? 0,
            }
          : {}),
        ...(animation ? { animation } : {}),
      },
      null,
      2,
    ),
  );

  return {
    itemId,
    slice: skin.slice,
    imageSize: skin.imageSize,
    textColor: skin.textColor,
    animated,
    staticPng: `dress/bubble/${itemId}/static.png`,
    frames,
    animation,
    ...(frames
      ? {
          frameTimeMs: skin.animationFrameTimeMs,
          repeat: skin.animationRepeat ?? 0,
        }
      : {}),
  };
}

/** 一款挂件：动画帧 + 静态底图 + widget.json（时间轴），不再合成 GIF。 */
async function exportWidget(
  dressInstall: DressService,
  root: string,
  itemId: number,
): Promise<DressWidgetManifest> {
  const dir = join(root, 'widget', String(itemId));
  mkdirSync(dir, { recursive: true });

  // 1. 动画帧原样导出。
  const anim = await dressInstall.resolvePendantAnimation(itemId);
  let frames: string[] | null = null;
  let frameTimeMs: number | undefined;
  let repeat: number | undefined;
  if (anim && anim.frameCount > 0) {
    const frameFiles: string[] = [];
    const framesDir = join(dir, 'frames');
    mkdirSync(framesDir, { recursive: true });
    for (let i = 1; i <= anim.frameCount; i++) {
      const file = dressInstall.pendantFrameFile(itemId, i);
      if (!file) break;
      copyFileSync(file, join(framesDir, `${i}.png`));
      frameFiles.push(`dress/widget/${itemId}/frames/${i}.png`);
    }
    if (frameFiles.length === anim.frameCount) {
      frames = frameFiles;
      frameTimeMs = anim.frameTimeMs;
      repeat = anim.repeat;
      writeFileSync(
        join(dir, 'widget.json'),
        JSON.stringify(
          {
            itemId,
            frameCount: anim.frameCount,
            frameTimeMs: anim.frameTimeMs,
            repeat: anim.repeat,
          },
          null,
          2,
        ),
      );
    }
  }

  // 2. 静态底图（aio_50.png）：有动画也一并导出，HTML 预览用它。
  let preview: string | null = null;
  const staticFile = await dressInstall.pendantStaticFile(itemId);
  if (staticFile) {
    copyFileSync(staticFile, join(dir, 'widget.png'));
    preview = `dress/widget/${itemId}/widget.png`;
  }

  // HTML 预览单图：静态底优先，其次动画首帧。
  const file = preview ?? frames?.[0] ?? null;
  if (!file) throw new Error('挂件动画帧与静态图都不可用');

  return {
    itemId,
    animated: Boolean(frames),
    file,
    frames,
    ...(frameTimeMs !== undefined ? { frameTimeMs, repeat } : {}),
  };
}

/** bundle 目录下的 dress 清单路径。 */
export function dressManifestPath(outDir: string): string {
  return join(outDir, DRESS_DIR, 'manifest.json');
}

/** 读取之前 dress 阶段写下的清单（HTML 导出在消息流写入前读取）。 */
export function readDressManifest(outDir: string): DressExportManifest | null {
  const path = dressManifestPath(outDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DressExportManifest;
  } catch {
    return null;
  }
}
