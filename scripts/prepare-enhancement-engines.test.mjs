import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = new URL('./prepare-enhancement-engines.mjs', import.meta.url);
const BARREL = 'packages/service/src/index.ts';

/** 脚本里所有 `tsImport('…')` 的目标（相对 scripts/）。 */
async function importTargets() {
  const source = await readFile(script, 'utf8');
  return [...source.matchAll(/tsImport\(\s*'([^']+)'/g)].map((match) => match[1]);
}

/** 该 TS 入口的真实依赖图（esbuild 走 node 解析，不打 @weq/* 黑洞）。 */
async function moduleGraph(entry) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [fileURLToPath(new URL(entry, script))],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs).map((path) => path.replaceAll('\\', '/'));
}

// electron-builder 在 beforePack 阶段用 tsx 现场编译这些模块。Windows runner 上
// 一旦经过 `@weq/service` 桶（1000+ 模块），编译会久到把 "Package + publish
// release" 挂住（v2.7.1 的 windows job 就是这么卡了 60 分钟）。
test('打包前置脚本只 import 依赖图很小的叶子模块，不经过 @weq/service 桶', async () => {
  const targets = await importTargets();
  assert.ok(targets.length >= 4, '仍应逐个 tsImport 清单模块');
  for (const target of targets) {
    const graph = await moduleGraph(target);
    assert.ok(
      !graph.includes(BARREL),
      `${target} 把 ${BARREL} 拖进了打包前置脚本，Windows 打包会卡死`,
    );
  }
});

test('意图模型清单是零依赖叶子模块', async () => {
  assert.deepEqual(await moduleGraph('../apps/desktop/src/shared/laya_bundle.ts'), [
    'apps/desktop/src/shared/laya_bundle.ts',
  ]);
});
