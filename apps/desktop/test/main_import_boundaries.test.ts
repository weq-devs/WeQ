// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../src/main');
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}
const imports = files(root).flatMap((path) => {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const result: Array<{ source: string; target: string; dynamic: boolean }> = [];
  const add = (specifier: ts.Expression, dynamic: boolean) => {
    if (ts.isStringLiteral(specifier) && specifier.text.startsWith('.'))
      result.push({
        source: path,
        target: resolve(dirname(path), specifier.text).replace(/\.ts$/, ''),
        dynamic,
      });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause?.isTypeOnly ||
        (!clause?.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.every((element) => element.isTypeOnly));
      if (!onlyTypes) add(node.moduleSpecifier, false);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      add(node.moduleSpecifier, false);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0]
    ) {
      add(node.arguments[0], true);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
});

it.each([
  ['voice', true],
  ['mcp/openai_tools', false],
  ['capture_session', false],
] as const)('主进程 %s 统一加载方式，不再产生无效动态导入', (name, dynamic) => {
  const consumers = imports.filter((entry) => entry.target === resolve(root, name));
  expect(consumers.length).toBeGreaterThan(0);
  expect(consumers.filter((entry) => entry.dynamic !== dynamic)).toEqual([]);
});
