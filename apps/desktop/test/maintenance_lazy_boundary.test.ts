// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../src/renderer/src');
function runtimeImports(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return file.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) &&
    !statement.importClause?.isTypeOnly &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

it('设置入口不提前加载维护弹窗和导出工作区', () => {
  const entry = resolve(root, 'components/settings/DataMaintenanceSection.tsx');
  expect(runtimeImports(entry)).not.toContain('../../views/ExportView');
  expect(readFileSync(entry, 'utf8')).not.toContain('export function DataMaintenanceDialog');
  for (const name of ['DataMaintenanceDialog', 'DatabaseManagementSection']) {
    const path = resolve(root, `components/settings/${name}.tsx`);
    expect(runtimeImports(path)).not.toContain('../../views/ExportView');
    expect(runtimeImports(path)).toContain('../lazyWorkspaces');
  }
  const loaders = readFileSync(resolve(root, 'components/lazyWorkspaces.ts'), 'utf8');
  expect(loaders).toContain("import('./settings/DataMaintenanceDialog')");
  expect(loaders).not.toContain("import('./settings/DataMaintenanceSection')");
});
