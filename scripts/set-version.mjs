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
 *
 * 另外同步 packages/daemon 的 Cargo.toml / Cargo.lock：守护进程报的版本号来自
 * Cargo.toml，GUI 侧靠它判断「磁盘上的二进制换了没」——不同步的话升级后版本没变，
 * 旧守护进程会被一直留着跑，新二进制永远不生效。
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

/**
 * 在 `marker` 行之后的同一节里，把第一处 `version = "x"` 改成目标版本。
 * 找不到节 / 找不到版本行时返回 null（调用方跳过）。
 */
function bumpVersionLine(file, marker, version) {
  const lines = readFileSync(file, 'utf-8').split('\n');
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    // 保住行尾的 \r（Cargo.lock 是 CRLF），只换版本号本身。
    const match = /^(\s*version = ")([^"]+)("[\s\S]*)$/.exec(raw);
    if (!match) {
      if (raw.trimStart().startsWith('[')) break;
      continue;
    }
    if (match[2] === version) return { old: version, changed: false };
    lines[i] = `${match[1]}${version}${match[3]}`;
    if (!dryRun) writeFileSync(file, lines.join('\n'));
    return { old: match[2], changed: true };
  }
  return null;
}

// Rust 侧（守护进程 `ping.version` 的来源）跟着一起走。
for (const [file, marker] of [
  [join(repoRoot, 'packages', 'daemon', 'Cargo.toml'), '[package]'],
  [join(repoRoot, 'packages', 'daemon', 'Cargo.lock'), 'name = "weq-daemon"'],
]) {
  if (!existsSync(file)) continue;
  const rel = file.replace(`${repoRoot}/`, '');
  const bumped = bumpVersionLine(file, marker, version);
  if (!bumped) {
    console.log(`  跳过（找不到版本行）: ${rel}`);
    continue;
  }
  if (!bumped.changed) {
    console.log(`  跳过（已是 ${version}）: ${rel}`);
    continue;
  }
  changed += 1;
  console.log(`  ${bumped.old} → ${version}: ${rel}`);
}

console.log(
  dryRun
    ? `[dry-run] 将修改 ${changed} 处版本号 → ${version}`
    : `已把 ${changed} 处版本号统一到 ${version}。记得运行 pnpm i 刷新 lockfile。`,
);
