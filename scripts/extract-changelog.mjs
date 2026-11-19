#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抽取某版本的 Markdown 正文，供发布工作流和版本索引使用。
 *
 * 约定见 AGENTS.md：`## <版本> [- 日期]` 开段，保留 `###` 副标题和正文。
 * 用法：`node scripts/extract-changelog.mjs v0.5.0 [CHANGELOG.md]`
 * 版本号带不带 `v` 前缀都接受。找不到章节时退出码 1（CI 里显式失败）。
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 抽出某版本章节的原始 Markdown 行（保留嵌套缩进）；找不到返回空串。 */
export function extractSection(raw, version) {
  const wanted = version.replace(/^v/i, '').trim();
  const lines = raw.split(/\r?\n/);
  const section = [];
  let inSection = false;
  for (const line of lines) {
    // 任意 `##` 标题都结束当前章节（含 `## Unreleased` 这类非版本标题）。
    if (/^##\s+/.test(line)) {
      if (inSection) break; // 下一个 `##` 标题 = 本章节结束
      const heading = /^##\s+v?(\d[^\s]*)/.exec(line);
      if (heading && (heading[1] ?? '') === wanted) inSection = true;
      continue;
    }
    if (inSection) section.push(line);
  }
  return section.join('\n').replace(/^\n+|\n+$/g, '');
}

/** CLI 入口判定：被 import 时不执行命令行逻辑。 */
function isMain() {
  return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMain()) {
  const tag = process.argv[2] ?? '';
  const file = process.argv[3] ?? 'CHANGELOG.md';
  try {
    const text = extractSection(readFileSync(file, 'utf-8'), tag);
    if (!text.trim()) {
      console.error(`CHANGELOG.md 里没有 ${tag.replace(/^v/i, '')} 的章节`);
      process.exit(1);
    }
    console.log(text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
