#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抽取某版本的章节纯文本（release 工作流专用）。
 *
 * 约定见 CHANGELOG.md 头部：`## <版本> [- 日期]` 开段，`-` 开头的行为 bullet。
 * 用法：`node scripts/extract-changelog.mjs v0.5.0 [CHANGELOG.md]`
 * 版本号带不带 `v` 前缀都接受。找不到章节时退出码 1（CI 里显式失败）。
 */

import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const file = process.argv[3] ?? 'CHANGELOG.md';
const wanted = tag.replace(/^v/i, '').trim();

function extract(raw, version) {
  const lines = raw.split(/\r?\n/);
  const section = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    // 任意 `##` 标题都结束当前章节（含 `## Unreleased` 这类非版本标题）。
    if (/^##\s+/.test(trimmed)) {
      if (inSection) break; // 下一个 `##` 标题 = 本章节结束
      const heading = /^##\s+v?(\d[^\s]*)/.exec(trimmed);
      if (heading && (heading[1] ?? '') === version) inSection = true;
      continue;
    }
    if (inSection && trimmed) section.push(trimmed);
  }
  return section.filter((l) => !/^#/.test(l)).join('\n');
}

try {
  const raw = readFileSync(file, 'utf-8');
  const text = extract(raw, wanted);
  if (!text) {
    console.error(`CHANGELOG.md 里没有 ${wanted} 的章节`);
    process.exit(1);
  }
  console.log(text);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
