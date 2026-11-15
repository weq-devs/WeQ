#!/usr/bin/env node
/**
 * 把主仓的 QQ 版本清单同步进文档目录。
 *
 * 文档站是独立仓库（`weq-devs/WeQDocs`），读不到主仓的 `versions/`。主仓里
 * `docs/versions/` 通过这个脚本生成，并被 `.gitignore` 排除 —— 权威数据仍然只有
 * 主仓 `versions/*.json` 一份，这里只是构建期的副本。
 *
 * 用法：
 *
 *   node scripts/sync-docs-versions.mjs           # 写盘
 *   node scripts/sync-docs-versions.mjs --check   # 只校验，不写盘
 *
 * 主仓 `pnpm dev` 与 docs 的 CI 都会先跑它，所以「本地看着对、CI 报错」的
 * 漂移不会发生。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(root, 'versions');
const TARGET = join(root, 'docs', 'versions');
const FILES = ['supported.json', 'latest.json'];
const checkOnly = process.argv.includes('--check');

if (!existsSync(SOURCE)) {
  process.stderr.write(`✖ 找不到 ${SOURCE}\n`);
  process.exit(1);
}

mkdirSync(TARGET, { recursive: true });

const stale = [];
for (const name of FILES) {
  const from = join(SOURCE, name);
  const to = join(TARGET, name);
  if (!existsSync(from)) {
    process.stderr.write(`✖ 缺少 ${from}\n`);
    process.exit(1);
  }
  const source = readFileSync(from, 'utf8');
  const current = existsSync(to) ? readFileSync(to, 'utf8') : null;
  if (current !== source) stale.push(name);
  if (!checkOnly) copyFileSync(from, to);
}

if (checkOnly) {
  if (stale.length > 0) {
    process.stderr.write(
      `✖ docs/versions 与主仓不一致（${stale.join(', ')}），重跑 \`pnpm docs:versions\`\n`,
    );
    process.exit(1);
  }
  process.stdout.write('✓ 文档版本清单与主仓一致\n');
  process.exit(0);
}

process.stdout.write(
  stale.length > 0
    ? `✓ 已同步 ${stale.length} 个版本清单到 docs/versions\n`
    : '✓ 文档版本清单已是最新\n',
);
