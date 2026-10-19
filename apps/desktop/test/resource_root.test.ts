/**
 * `resources/` 根目录探测（`src/main/resource.ts`）的离线单测。
 *
 * 回归背景：electron-vite 6 会把共享模块拆成 `out/main/chunks/<name>-<hash>.mjs`，
 * 而 `resolveResourceRoot()` 原来写死了「`out/main` 往上四级就是仓库根」，层级一深就
 * 指到 `apps/resources`，于是所有 `resolveResource()` 都返回 null —— 表现是
 * `weq-media://dress` 的名片占位图 404。
 *
 * 这里只验证探测逻辑本身：给它一个假的 bundle 目录（分别在 `out/main` 和
 * `out/main/chunks` 两个深度），断言都能找到仓库根的 `resources/`。
 * 跑法：`pnpm --filter @weq/desktop test`。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, test } from 'vitest';
import { resolveResourceRoot, walkUpForResources } from '../src/main/resource.ts';

const fakeRoots: string[] = [];

/** 造一个仓库布局：`<root>/resources/brand/logo.png` + 给定深度的 bundle 目录。 */
function makeRepo(bundleDepth: string[]): { repo: string; bundleDir: string } {
  const repo = mkdtempSync(join(tmpdir(), 'weq-resource-'));
  fakeRoots.push(repo);
  mkdirSync(join(repo, 'resources', 'brand'), { recursive: true });
  writeFileSync(join(repo, 'resources', 'brand', 'logo.png'), 'x');
  writeFileSync(join(repo, 'resources', 'hitokoto.json'), '{}');
  const bundleDir = join(repo, 'apps', 'desktop', 'out', 'main', ...bundleDepth);
  mkdirSync(bundleDir, { recursive: true });
  return { repo, bundleDir };
}

afterAll(() => {
  for (const root of fakeRoots) rmSync(root, { recursive: true, force: true });
});

test('bundle 在 out/main：上溯三级找到仓库根 resources', () => {
  const { repo, bundleDir } = makeRepo([]);
  assert.equal(walkUpForResources(bundleDir), join(repo, 'resources'));
});

test('bundle 在 out/main/chunks：多一层也能找到（electron-vite 6 的布局）', () => {
  const { repo, bundleDir } = makeRepo(['chunks']);
  assert.equal(walkUpForResources(bundleDir), join(repo, 'resources'));
});

test('认目录标志而非「有个叫 resources 的目录就收」', () => {
  const { bundleDir } = makeRepo(['chunks']);
  // 在 bundle 旁边放一个假的 resources/（没有 brand/logo.png），不能被它截胡。
  const decoy = join(bundleDir, 'resources');
  mkdirSync(decoy, { recursive: true });
  assert.notEqual(walkUpForResources(bundleDir), decoy);
});

test('空目录树返回 null 而不是抛错', () => {
  const empty = mkdtempSync(join(tmpdir(), 'weq-empty-'));
  fakeRoots.push(empty);
  assert.equal(walkUpForResources(dirname(join(empty, 'x'))), null);
});

test('真实仓库里 resolveResourceRoot 能找到 resources（源码目录深度也要成立）', () => {
  // moduleDir 是 src/main，另有一条「上溯」路径兜底；这里确保它没被层级假设带偏。
  assert.ok(resolveResourceRoot()?.endsWith('/resources'));
});
