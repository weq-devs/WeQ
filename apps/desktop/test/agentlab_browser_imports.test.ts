// @vitest-environment node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { test } from 'vitest';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

test('渲染层只能从 AgentLab 根入口导入类型，运行时工具使用浏览器安全子入口', () => {
  const invalid: string[] = [];
  for (const path of sourceFiles(join(desktop, 'src/renderer/src'))) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      if (statement.moduleSpecifier.text !== '@weq/agentlab') continue;
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      if (
        !clause ||
        clause.name ||
        !bindings ||
        ts.isNamespaceImport(bindings) ||
        bindings.elements.some((binding) => !binding.isTypeOnly)
      )
        invalid.push(path);
    }
  }
  assert.deepEqual(invalid, []);
});

test('模型选择子入口能直接打包进浏览器，不依赖 Node 内置模块', async () => {
  const result = await build({
    absWorkingDir: desktop,
    stdin: {
      contents:
        "export { isDefaultModelSelection, modelSelectionKey } from '@weq/agentlab/model-selection';",
      resolveDir: desktop,
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  assert.equal(result.outputFiles.length, 1);
  assert.match(result.outputFiles[0].text, /isDefaultModelSelection/);
});
