#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抽取某版本的 Markdown 正文，供发布工作流和版本索引使用。
 *
 * 约定见 AGENTS.md：`## <版本> [- 日期]` 开段，保留 `###` 副标题和正文。
 * 用法：`node scripts/extract-changelog.mjs <版本号|Unreleased> [CHANGELOG.md]`
 * 版本号可带 `v` 前缀。正式版本章节缺失或为空时退出码 1，Unreleased 可为空。
 * `--previous-stable <标签> [CHANGELOG.md]` 从标准输入读取已公开的正式版标签，每行一个。
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { versionInput } from './version-input.mjs';

/** 抽出指定章节的原始 Markdown 行（保留嵌套缩进），找不到返回空串。 */
export function extractSection(raw, version) {
  const wanted = version.replace(/^v/i, '').trim();
  const lines = raw.split(/\r?\n/);
  const section = [];
  let inSection = false;
  for (const line of lines) {
    // 任意 `##` 标题都结束当前章节（含 `## Unreleased` 这类非版本标题）。
    if (/^##\s+/.test(line)) {
      if (inSection) break; // 下一个 `##` 标题 = 本章节结束
      const heading = /^##\s+(?:v?(\d\S*)|(Unreleased)(?=\s|$))/.exec(line);
      if (heading && (heading[1] ?? heading[2]) === wanted) inSection = true;
      continue;
    }
    if (inSection) section.push(line);
  }
  return section.join('\n').replace(/^\n+|\n+$/g, '');
}

function compareCoreVersions(left, right) {
  const [leftMajor, leftMinor, leftPatch] = left.split('+', 1)[0].split('.').map(Number);
  const [rightMajor, rightMinor, rightPatch] = right.split('+', 1)[0].split('.').map(Number);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}

export function previousStableTag(raw, tag, publishedTags) {
  const core = versionInput(tag)?.split(/[-+]/, 1)[0];
  if (!core) throw new Error('缺少有效的发布版本');

  const published = new Set(publishedTags);
  const headings = raw.matchAll(/^##[ \t]+v?(\d+\.\d+\.\d+(?:\+[\w.-]+)?)(?=[ \t\r]|$)/gm);
  let previous;
  for (const [, version] of headings) {
    if (!published.has(`v${version}`) || compareCoreVersions(version, core) >= 0) continue;
    if (!previous || compareCoreVersions(version, previous) > 0) previous = version;
  }
  return previous ? `v${previous}` : '';
}

/** CLI 入口判定：被 import 时不执行命令行逻辑。 */
function isMain() {
  return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const findPrevious = args[0] === '--previous-stable';
  const [tag = '', file = 'CHANGELOG.md'] = findPrevious ? args.slice(1) : args;
  try {
    const raw = readFileSync(file, 'utf-8');
    if (findPrevious) {
      const publishedTags = readFileSync(0, 'utf-8').split(/\r?\n/);
      const previous = previousStableTag(raw, tag, publishedTags);
      if (previous) console.log(previous);
      process.exit(0);
    }
    const text = extractSection(raw, tag);
    if (!text.trim()) {
      if (tag === 'Unreleased') process.exit(0);
      console.error(`CHANGELOG.md 里没有 ${tag.replace(/^v/i, '')} 的章节`);
      process.exit(1);
    }
    console.log(text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
