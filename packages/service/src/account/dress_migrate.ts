/**
 * 装扮清单迁移工具 — 从旧的 cache/dress/{uin}_{hash}/manifest.json 迁移到新架构。
 *
 * 迁移策略：
 *  1. 读取旧 manifest.json（如果存在）。
 *  2. 气泡/字体的资源文件（PNG/TTF）移动到 cache/dress_shared/。
 *  3. 账号配置（activeBubble/activeFont/scope）写入 config/accounts/{configId}/dress.json。
 *  4. 迁移完成后删除旧 manifest.json，但保留目录（里面可能有 background/）。
 *
 * 兼容性：
 *  - 迁移是幂等的：多次运行不会重复迁移。
 *  - 迁移不是强制的：旧清单不存在时静默跳过。
 *  - 迁移失败不会中断启动：记录警告日志，账号照常打开（从空配置开始）。
 */

import { existsSync, readFileSync, copyFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BubbleSkin } from './bubble_skin';
import { DressConfigService, type BubbleMeta, type FontMeta } from './dress_config';
import type { BubbleSidecar } from './dress_shared_cache';
import { writeFileAtomicSync } from './atomic_write';
import { getLogger, logErrorContext } from '../common/logger';

/** 旧 manifest.json 的结构（兼容读取）。 */
interface LegacyManifest {
  bubbles: BubbleSkin[];
  fonts: Array<{
    itemId: number;
    name: string;
    previewUrl?: string;
    family: string;
    file: string;
  }>;
  activeBubble: number;
  activeFont: number;
  scope: 'mine' | 'all';
  background: 'none' | 'qq' | 'custom';
  backgroundFile: string;
  widgetId: string;
  backgroundOpacity: number;
}

const logger = getLogger().child({ scope: 'dress-migrate' });

/**
 * 迁移单个账号的装扮数据。
 *
 * @param legacyRootDir 旧的账号装扮目录（如 `cache/dress/1707889225_948a69a9/`）。
 * @param sharedDir 新的全局共享目录（如 `cache/dress_shared/`）。
 * @param configService 账号配置服务（写入新的 dress.json）。
 */
export function migrateDressData(
  legacyRootDir: string,
  sharedDir: string,
  configService: DressConfigService,
): void {
  const manifestPath = join(legacyRootDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    // 旧清单不存在，说明这是新账号或已经迁移过了。
    return;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as LegacyManifest;
    logger.info('migrating dress data from legacy manifest', {
      event: 'dress-migrate-start',
      legacyDir: legacyRootDir,
      bubbleCount: manifest.bubbles.length,
      fontCount: manifest.fonts.length,
    });

    // 1. 迁移气泡资源文件 + 生成 sidecar。
    const bubblesDir = join(sharedDir, 'bubbles');
    const bubbleMeta: Record<string, BubbleMeta> = {};

    for (const bubble of manifest.bubbles) {
      try {
        // 生成 sidecar（元数据）。
        const sidecarPath = join(bubblesDir, `${bubble.itemId}.json`);
        if (!existsSync(sidecarPath)) {
          const sidecar: BubbleSidecar = {
            itemId: bubble.itemId,
            slice: bubble.slice,
            imageSize: bubble.imageSize,
            animated: bubble.animated,
            textColor: bubble.textColor,
            ...(bubble.animationFrameCount
              ? {
                  animationFrameCount: bubble.animationFrameCount,
                  animationFrameTimeMs: bubble.animationFrameTimeMs,
                  animationRepeat: bubble.animationRepeat,
                }
              : {}),
          };
          writeFileAtomicSync(sidecarPath, JSON.stringify(sidecar, null, 2));
        }

        // 迁移本地文件（如果有）。
        if (bubble.localFile && existsSync(bubble.localFile)) {
          const destFile = join(bubblesDir, `${bubble.itemId}.png`);
          if (!existsSync(destFile)) {
            copyFileSync(bubble.localFile, destFile);
          }
        }

        // 迁移帧动画文件（如果有）。
        if (bubble.animationFrameCount) {
          for (let i = 1; i <= bubble.animationFrameCount; i++) {
            const srcFrame = join(legacyRootDir, 'bubbles', `${bubble.itemId}-frame-${i}.png`);
            const destFrame = join(bubblesDir, `${bubble.itemId}-frame-${i}.png`);
            if (existsSync(srcFrame) && !existsSync(destFrame)) {
              copyFileSync(srcFrame, destFrame);
            }
          }
        }

        // 收集商城元数据。
        bubbleMeta[bubble.itemId] = {
          name: bubble.name,
          previewUrl: bubble.previewUrl,
        };
      } catch (e) {
        logger.warn('failed to migrate bubble', {
          event: 'dress-migrate-bubble-failed',
          itemId: bubble.itemId,
          ...logErrorContext(e),
        });
      }
    }

    // 2. 迁移字体资源文件。
    const fontsDir = join(sharedDir, 'fonts');
    const fontMeta: Record<string, FontMeta> = {};

    for (const font of manifest.fonts) {
      try {
        // 迁移 ttf 文件。
        if (font.file && existsSync(font.file)) {
          const destFile = join(fontsDir, `${font.itemId}.ttf`);
          if (!existsSync(destFile)) {
            copyFileSync(font.file, destFile);
          }
        }

        // 收集商城元数据。
        fontMeta[font.itemId] = {
          name: font.name,
          previewUrl: font.previewUrl,
        };
      } catch (e) {
        logger.warn('failed to migrate font', {
          event: 'dress-migrate-font-failed',
          itemId: font.itemId,
          ...logErrorContext(e),
        });
      }
    }

    // 3. 迁移挂件资源文件（如果有）。
    const pendantsDir = join(sharedDir, 'pendants');
    const legacyPendantsDir = join(legacyRootDir, 'pendants');
    if (existsSync(legacyPendantsDir)) {
      try {
        for (const file of readdirSync(legacyPendantsDir)) {
          const srcPath = join(legacyPendantsDir, file);
          const destPath = join(pendantsDir, file);
          if (statSync(srcPath).isFile() && !existsSync(destPath)) {
            copyFileSync(srcPath, destPath);
          }
        }
      } catch (e) {
        logger.warn('failed to migrate pendants', {
          event: 'dress-migrate-pendants-failed',
          ...logErrorContext(e),
        });
      }
    }

    // 4. 写入新配置文件。
    const config = configService.read();
    config.installedBubbles = manifest.bubbles.map((b) => b.itemId);
    config.installedFonts = manifest.fonts.map((f) => f.itemId);
    config.bubbleMeta = bubbleMeta;
    config.fontMeta = fontMeta;
    config.activeBubble = manifest.activeBubble;
    config.activeFont = manifest.activeFont;
    config.scope = manifest.scope;
    config.background = manifest.background;
    config.widgetId = manifest.widgetId;
    config.backgroundOpacity = manifest.backgroundOpacity;

    // 背景文件迁移：如果是自定义背景，提取文件名（不含路径）。
    if (manifest.background === 'custom' && manifest.backgroundFile) {
      const bgFileName = manifest.backgroundFile.split(/[\\/]/).pop() ?? '';
      config.backgroundFile = bgFileName;
    }

    configService.write(config);

    // 5. 删除旧 manifest.json（标记迁移完成）。
    rmSync(manifestPath, { force: true });

    logger.info('dress data migration completed', {
      event: 'dress-migrate-success',
      legacyDir: legacyRootDir,
      bubblesMigrated: manifest.bubbles.length,
      fontsMigrated: manifest.fonts.length,
    });
  } catch (e) {
    logger.error('dress data migration failed', {
      event: 'dress-migrate-failed',
      legacyDir: legacyRootDir,
      ...logErrorContext(e),
    });
    // 迁移失败不中断启动，账号从空配置开始。
  }
}
