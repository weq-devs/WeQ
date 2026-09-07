/**
 * 一键修改版本号 —— 把 monorepo 里所有 package.json 的 `version` 统一改成目标版本。
 *
 * 用法：
 *   pnpm run version:set 0.5.0            # 实际写入
 *   pnpm run version:set 0.5.0 --dry-run  # 只打印将要修改的文件
 *   （也支持带 v 前缀：pnpm run version:set v0.5.0）
 *
 * 覆盖范围：仓库根 + apps/* + packages/* 的 package.json（跳过 node_modules /
 * dist / target 等产物目录）。pnpm-lock.yaml 不动 —— 下次 `pnpm i` 自然对齐。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const raw = args.find((a) => !a.startsWith('--'));
const version = raw?.replace(/^v/i, '');

if (!version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
  console.error('用法: pnpm run version:set <x.y.z> [--dry-run]');
  process.exit(1);
}

/** 目标 package.json 清单（根 + 一级 workspace 包）。 */
function targets() {
  const list = [join(repoRoot, 'package.json')];
  for (const scope of ['apps', 'packages']) {
    const dir = join(repoRoot, scope);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const pkg = join(dir, name.name, 'package.json');
      if (existsSync(pkg)) list.push(pkg);
    }
  }
  return list;
}

let changed = 0;
for (const pkg of targets()) {
  const json = JSON.parse(readFileSync(pkg, 'utf-8'));
  if (json.version === version) {
    console.log(`  跳过（已是 ${version}）: ${pkg.replace(`${repoRoot}/`, '')}`);
    continue;
  }
  const old = json.version;
  json.version = version;
  if (!dryRun) {
    writeFileSync(pkg, `${JSON.stringify(json, null, 2)}\n`);
  }
  changed += 1;
  console.log(`  ${old} → ${version}: ${pkg.replace(`${repoRoot}/`, '')}`);
}

console.log(
  dryRun
    ? `[dry-run] 将修改 ${changed} 个 package.json → ${version}`
    : `已把 ${changed} 个 package.json 统一到 ${version}。记得运行 pnpm i 刷新 lockfile。`,
);
