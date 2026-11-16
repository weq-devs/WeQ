import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function verifyImports(code) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /metadata-imports-ok/);
}

test('增强包准备按真实构建顺序导入，不等待完整账号服务加载', () => {
  verifyImports(`
        import assert from 'node:assert/strict';
        import { tsImport } from 'tsx/esm/api';
        await import('./scripts/prepare-enhancement-engines.mjs');
        const parent = new URL('./scripts/prepare-enhancement-engines.mjs', import.meta.url).href;
        await tsImport('../apps/desktop/src/main/enhancements/release_catalog.ts', parent);
        await tsImport('../packages/service/src/common/ocr_models.ts', parent);
        await tsImport('../packages/service/src/common/voice_transcribe.ts', parent);
        const { layaModelEntry } = await tsImport('../apps/desktop/src/shared/laya_bundle.ts', parent);
        const model = layaModelEntry();
        assert.ok(model.files.length > 0);
        assert.ok(model.files.every(file => file.sizeBytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256)));
        process.stdout.write('metadata-imports-ok');
      `);
});

test('增强引擎验证在独立进程导入，保持与发布命令相同的加载边界', () => {
  verifyImports(`
    import assert from 'node:assert/strict';
    import { tsImport } from 'tsx/esm/api';
    const parent = new URL('./scripts/verify-enhancement-engines.mjs', import.meta.url).href;
    const { EnhancementEngineStore } = await tsImport('../apps/desktop/src/main/enhancements/engine_store.ts', parent);
    const { parseEnhancementEngineManifest } = await tsImport('../apps/desktop/src/shared/enhancement_manifest.ts', parent);
    assert.equal(typeof EnhancementEngineStore, 'function');
    assert.equal(typeof parseEnhancementEngineManifest, 'function');
    process.stdout.write('metadata-imports-ok');
  `);
});
