// @vitest-environment node
import { expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

it('渲染层不从服务端总入口导入运行时值，助手默认参数可独立打入浏览器', () => {
  const root = fileURLToPath(new URL('../src/renderer/src', import.meta.url));
  const violations: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.tsx?$/.test(path)) {
        const source = ts.createSourceFile(
          path,
          readFileSync(path, 'utf8'),
          ts.ScriptTarget.Latest,
        );
        for (const node of source.statements) {
          if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
          if (node.moduleSpecifier.text !== '@weq/service') continue;
          const clause = node.importClause;
          if (clause?.isTypeOnly) continue;
          const bindings = clause?.namedBindings;
          if (
            !clause?.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every((item) => item.isTypeOnly)
          )
            continue;
          violations.push(path.slice(root.length + 1));
        }
      }
    }
  }
  visit(root);
  expect(violations).toEqual([]);
  const result = buildSync({
    stdin: {
      contents: "export { ASSISTANT_PARAMETER_DEFAULTS } from '@weq/service/assistant-config';",
      resolveDir: root,
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  expect(Object.keys(result.metafile!.inputs).filter((path) => path !== '<stdin>')).toEqual([
    expect.stringContaining('account/assistant_config.ts'),
  ]);
});
