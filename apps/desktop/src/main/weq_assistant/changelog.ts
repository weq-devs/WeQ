/**
 * CHANGELOG.md 的读取与解析 —— release 推文内容的数据源。
 *
 * 约定（保持 Keep a Changelog 风格，可手写）：
 *
 *     # Changelog
 *
 *     ## 0.5.0 - 2026-09-07
 *     - 新增守护进程设置页，展示守护进程健康状态
 *     - 新版本发布时推文 + 系统通知提醒
 *
 *     ## 0.4.6 - 2026-08-30
 *     - ...
 *
 * 解析规则：`## <version> [- 日期]` 开一段；段内以 `-` 开头的行是 bullet；
 * `summary` = 第一条 bullet（封面 / 通知用的一句话摘要）；`bullets` = 全部。
 * release 工作流（release.yml）与推文 / 通知都从这里取内容，双端一致。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { getLogger } from '@weq/service';

const logger = getLogger().child({ scope: 'weq-assistant-changelog' });

export interface ChangelogEntry {
  /** 版本号（`0.5.0`，不带 v）。 */
  version: string;
  /** 段落日期（`2026-09-07` 或 null）。 */
  date: string | null;
  /** 该版本的全部 bullet（纯文本，已剥 Markdown 前缀符号）。 */
  bullets: string[];
  /** 第一条 bullet（没有则回退 `WeQ <version> 发布`）。 */
  summary: string;
}

/** CHANGELOG.md 的绝对路径：打包 = resources/CHANGELOG.md；开发 = 仓库根。 */
function changelogPath(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'resources', 'CHANGELOG.md') : null,
    app.isPackaged ? join(process.resourcesPath ?? '', 'CHANGELOG.md') : null,
    join(app.getAppPath(), 'CHANGELOG.md'),
    join(app.getAppPath(), '..', '..', 'CHANGELOG.md'),
    join(app.getAppPath(), '..', '..', '..', '..', 'CHANGELOG.md'),
    join(process.cwd(), 'CHANGELOG.md'),
  ].filter((p): p is string => !!p && existsSync(p));
  return candidates[0] ?? null;
}

/** 读整份 CHANGELOG.md 并解析；文件缺失 / 空返回 []。 */
export function loadChangelog(): ChangelogEntry[] {
  const path = changelogPath();
  if (!path) {
    logger.warn('changelog file not found', { event: 'changelog-missing' });
    return [];
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    return parseChangelog(raw);
  } catch (error) {
    logger.warn('failed to read changelog', {
      event: 'changelog-read-failed',
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** 取某版本的章节；不存在返回 null（推文回退默认文案）。 */
export function getReleaseChangelogEntry(version: string): ChangelogEntry | null {
  const wanted = version.replace(/^v/i, '');
  return loadChangelog().find((e) => e.version === wanted) ?? null;
}

/** 纯函数解析（可单测的形状约定）。 */
export function parseChangelog(raw: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const heading = /^##\s+v?(\d[^\s]*)(?:\s+-\s+(\S+))?/.exec(line.trim());
    if (heading) {
      if (current) entries.push(current);
      current = {
        version: heading[1] ?? '',
        date: heading[2] ?? null,
        bullets: [],
        summary: '',
      };
      continue;
    }
    if (!current) continue;
    const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
    if (bullet?.[1]) current.bullets.push(bullet[1].trim());
  }
  if (current) entries.push(current);
  for (const e of entries) {
    e.summary = e.bullets[0] ?? `WeQ ${e.version} 发布`;
  }
  return entries;
}
