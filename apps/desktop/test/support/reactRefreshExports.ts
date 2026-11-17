import ts from 'typescript';

function componentName(name: string): boolean {
  return /^[A-Z]/.test(name) && !/Context$/.test(name) && !/^[A-Z_\d]+$/.test(name);
}

function bindings(name: ts.BindingName): string[] {
  return ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) =>
        ts.isOmittedExpression(element) ? [] : bindings(element.name),
      );
}

/** 对组件模块检查运行时出口；type-only 出口不会参与 Vite 的热更新校验。 */
export function incompatibleReactExports(
  source: string,
  fileName: string,
  registered?: ReadonlySet<string>,
): string[] {
  if (registered?.size === 0) return [];
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const components = new Set<string>();
  const values = new Set<string>();
  const reexports = new Set<string>();
  const exports = new Map<string, string>();
  for (const statement of file.statements) {
    const exported = ts.canHaveModifiers(statement)
      ? ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      values.add(name);
      if (/^[A-Z]/.test(name)) components.add(name);
      if (exported) exports.set(name, name);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindings(declaration.name)) {
          values.add(name);
          const initializer = declaration.initializer;
          if (
            /^[A-Z]/.test(name) &&
            initializer &&
            (ts.isArrowFunction(initializer) ||
              ts.isFunctionExpression(initializer) ||
              (ts.isCallExpression(initializer) &&
                /(?:^|\.)(?:memo|forwardRef|lazy|lazyPanel|with[A-Z]\w*)$/.test(
                  initializer.expression.getText(file),
                )))
          )
            components.add(name);
          if (exported) exports.set(name, name);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const name = element.propertyName?.text ?? element.name.text;
        exports.set(element.name.text, name);
        if (statement.moduleSpecifier) reexports.add(name);
      }
    }
  }
  if (!registered && !components.size) return [];
  return [...exports].flatMap(([exported, local]) =>
    components.has(local) ||
    (reexports.has(local) && componentName(local)) ||
    (!values.has(local) && !reexports.has(local))
      ? []
      : [exported],
  );
}

export function registeredReactComponents(compiled: string): Set<string> {
  const file = ts.createSourceFile('compiled.js', compiled, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === '$RefreshReg$' &&
      node.arguments[1] &&
      ts.isStringLiteral(node.arguments[1])
    )
      names.add(node.arguments[1].text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}
